import { GoogleGenerativeAI } from "@google/generative-ai";
import { Confidence, EvidenceType, RoomStatus, Stance } from "@prisma/client";
import { appendAuditLog } from "@/lib/audit";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { classifyOutputBlock, classifyPromptBlock, validateSourceUrl } from "@/lib/security/agent-guard";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { sanitizeClaimText, sanitizeSnippet } from "@/lib/security/sanitize";

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

const VERI_AGENT_SYSTEM_PROMPT = `You are VeriAgent, a bounded research assistant inside VeriWire.
Your only job is to help verify or refute a specific claim using publicly available information.

You are NOT allowed to:
- Look up personal information about private individuals
- Access or summarize paywalled content
- Provide medical diagnoses or legal advice
- Generate content designed to persuade politically
- Make claims about individuals without multiple credible sources

If a request violates any rule above, respond only with:
BLOCKED: [rule name] | [one sentence explanation]

You MUST structure every evidence summary as:
OBSERVATION: [what the source explicitly states]
INFERENCE: [what this reasonably suggests about the claim]
SPECULATION: [what remains uncertain]

Confidence levels: LOW, MEDIUM, HIGH.
Always cite the source URL for every claim you make.
Never fabricate sources. If you cannot find evidence, say so.`;

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

function sourceNameFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown";
  }
}

async function callGemini(prompt: string) {
  if (!genAI) {
    return null;
  }

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  const result = await model.generateContent(`${VERI_AGENT_SYSTEM_PROMPT}\n\n${prompt}`);
  return result.response.text();
}

export async function normalizeClaim(claimRaw: string) {
  const cleaned = sanitizeClaimText(claimRaw);
  const blocked = classifyPromptBlock(cleaned);

  if (blocked.blocked) {
    return {
      blocked,
      claimNormalized: cleaned
    };
  }

  const prompt = `Claim to verify: ${cleaned}\nTask: Rewrite this as a concise core factual assertion in one sentence.`;
  const generated = await callGemini(prompt);

  if (!generated) {
    return {
      blocked: null,
      claimNormalized: cleaned
    };
  }

  return {
    blocked: null,
    claimNormalized: sanitizeClaimText(generated)
  };
}

async function generateSearchQueries(claimNormalized: string) {
  const prompt = `Claim to verify: ${claimNormalized}\nTask: Generate 3 to 5 short web search queries as a JSON array.`;
  const generated = await callGemini(prompt);

  if (!generated) {
    return [
      `${claimNormalized} fact check`,
      `${claimNormalized} official statement`,
      `${claimNormalized} verification`
    ];
  }

  const inlineArray = generated.match(/\[[\s\S]*\]/)?.[0];

  if (!inlineArray) {
    return [
      `${claimNormalized} fact check`,
      `${claimNormalized} official statement`,
      `${claimNormalized} verification`
    ];
  }

  try {
    const parsed = JSON.parse(inlineArray) as string[];
    return parsed.slice(0, 5);
  } catch {
    return [
      `${claimNormalized} fact check`,
      `${claimNormalized} official statement`,
      `${claimNormalized} verification`
    ];
  }
}

async function fetchSearchResults(claimNormalized: string, queries: string[]): Promise<SearchResult[]> {
  if (!env.BRAVE_SEARCH_API_KEY) {
    return [
      {
        title: "WHO guidance on rumor topic",
        url: "https://www.who.int/news-room",
        snippet: `Reference source discussing: ${claimNormalized}`
      },
      {
        title: "Government advisory",
        url: "https://www.gov.in",
        snippet: `Government portal update related to: ${claimNormalized}`
      },
      {
        title: "Independent fact check",
        url: "https://www.snopes.com",
        snippet: `Fact-check publication concerning: ${claimNormalized}`
      }
    ];
  }

  const all: SearchResult[] = [];

  for (const query of queries) {
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY
      },
      cache: "no-store"
    });

    if (!response.ok) {
      continue;
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };

    for (const result of data.web?.results ?? []) {
      all.push({
        title: result.title,
        url: result.url,
        snippet: sanitizeSnippet(result.description, 220)
      });
    }
  }

  return all.slice(0, 8);
}

function classifyStance(claim: string, snippet: string): { stance: Stance; type: EvidenceType; confidence: number } {
  const body = `${claim} ${snippet}`.toLowerCase();

  if (/(false|hoax|debunk|not true|no evidence|myth)/.test(body)) {
    return { stance: Stance.REFUTES, type: EvidenceType.OBSERVATION, confidence: 0.85 };
  }

  if (/(confirmed|true|proven|officially announced|verified)/.test(body)) {
    return { stance: Stance.SUPPORTS, type: EvidenceType.OBSERVATION, confidence: 0.7 };
  }

  return { stance: Stance.CONTEXT, type: EvidenceType.INFERENCE, confidence: 0.55 };
}

async function fetchPublicSnippet(url: string) {
  const guard = validateSourceUrl(url);

  if (guard.blocked) {
    return {
      blocked: guard,
      snippet: null
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "VeriWireAgent/1.0"
      },
      cache: "no-store"
    });

    if (response.status === 402) {
      return {
        blocked: {
          blocked: true as const,
          rule: "PAYWALLED_CONTENT" as const,
          explanation: "Source requires payment and is blocked by policy."
        },
        snippet: null
      };
    }

    const html = await response.text();
    const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
    const textOnly = stripped.replace(/<[^>]+>/g, " ");

    return {
      blocked: null,
      snippet: sanitizeSnippet(textOnly, 300)
    };
  } catch {
    return {
      blocked: null,
      snippet: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function confidenceLabel(score: number): Confidence {
  if (score >= 0.8) return Confidence.HIGH;
  if (score >= 0.6) return Confidence.MEDIUM;
  return Confidence.LOW;
}

async function summarizeEvidence(claim: string, evidenceRows: Array<{ sourceUrl: string; snippet: string; stance: Stance }>) {
  const serialized = JSON.stringify(evidenceRows.slice(0, 6));
  const prompt = `Claim to verify: ${claim}\nSearch results provided: ${serialized}\nTask: Analyze these results. For each relevant result produce a structured evidence item. Then produce an overall summary with your confidence level and recommended verdict.`;

  const generated = await callGemini(prompt);

  if (!generated) {
    const defaultText = [
      "OBSERVATION: Available public sources include mixed evidence with multiple independent references.",
      "INFERENCE: The claim appears likely false when refuting evidence outweighs supporting evidence.",
      "SPECULATION: Additional authoritative data may refine confidence."
    ].join("\n");

    return defaultText;
  }

  return generated;
}

export async function runAgentPipeline(roomId: string, actorId?: string) {
  await enforceRateLimit({
    key: `agent-run:${roomId}`,
    limit: 1,
    windowSeconds: 300
  });

  const room = await prisma.room.findUnique({
    where: { id: roomId }
  });

  if (!room) {
    throw new Error("Room not found");
  }

  await prisma.agentEvent.create({
    data: {
      roomId,
      step: "START",
      detail: "Agent run started",
      progress: 5
    }
  });

  const promptGuard = classifyPromptBlock(room.claimNormalized);
  if (promptGuard.blocked) {
    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "BLOCKED",
        detail: `BLOCKED: ${promptGuard.rule} | ${promptGuard.explanation}`,
        blocked: true,
        progress: 100
      }
    });

    await appendAuditLog({
      roomId,
      actorId,
      actorType: "AGENT",
      action: "AGENT_BLOCKED",
      payload: {
        rule: promptGuard.rule,
        explanation: promptGuard.explanation
      }
    });

    return {
      blocked: true,
      rule: promptGuard.rule
    };
  }

  const queries = await generateSearchQueries(room.claimNormalized);

  await prisma.agentEvent.create({
    data: {
      roomId,
      step: "QUERY_GENERATION",
      detail: `Generated ${queries.length} queries`,
      progress: 20
    }
  });

  const results = await fetchSearchResults(room.claimNormalized, queries);
  const savedEvidence: Array<{ sourceUrl: string; snippet: string; stance: Stance }> = [];

  for (const [index, result] of results.entries()) {
    const snippetResponse = await fetchPublicSnippet(result.url);

    if (snippetResponse.blocked) {
      await prisma.agentEvent.create({
        data: {
          roomId,
          step: "BLOCKED",
          detail: `BLOCKED: ${snippetResponse.blocked.rule} | ${snippetResponse.blocked.explanation}`,
          blocked: true,
          progress: Math.min(95, 30 + index * 10)
        }
      });

      await appendAuditLog({
        roomId,
        actorId,
        actorType: "AGENT",
        action: "AGENT_BLOCKED_SOURCE",
        payload: {
          rule: snippetResponse.blocked.rule,
          sourceUrl: result.url,
          explanation: snippetResponse.blocked.explanation
        }
      });

      continue;
    }

    const snippet = snippetResponse.snippet ?? result.snippet;
    if (!snippet) {
      continue;
    }

    const stanceClass = classifyStance(room.claimNormalized, snippet);

    await prisma.evidence.create({
      data: {
        roomId,
        submittedBy: "AGENT",
        sourceUrl: result.url,
        sourceName: sourceNameFromUrl(result.url),
        sourceFaviconUrl: `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(result.url)}`,
        snippet,
        stance: stanceClass.stance,
        type: stanceClass.type,
        agentConfidence: stanceClass.confidence,
        disputedBy: []
      }
    });

    savedEvidence.push({
      sourceUrl: result.url,
      snippet,
      stance: stanceClass.stance
    });

    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: `Processed ${index + 1}/${results.length} sources`,
        progress: Math.min(95, 30 + index * 10)
      }
    });
  }

  const summary = await summarizeEvidence(room.claimNormalized, savedEvidence);
  const outputGuard = classifyOutputBlock(summary);

  if (outputGuard.blocked) {
    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "BLOCKED",
        detail: `BLOCKED: ${outputGuard.rule} | ${outputGuard.explanation}`,
        blocked: true,
        progress: 100
      }
    });

    await appendAuditLog({
      roomId,
      actorId,
      actorType: "AGENT",
      action: "AGENT_OUTPUT_BLOCKED",
      payload: outputGuard
    });

    return {
      blocked: true,
      rule: outputGuard.rule
    };
  }

  const refutes = savedEvidence.filter((row) => row.stance === Stance.REFUTES).length;
  const confidenceScore = savedEvidence.length === 0 ? 0.3 : Math.min(0.95, 0.45 + refutes / Math.max(savedEvidence.length, 1));

  await prisma.agentEvent.create({
    data: {
      roomId,
      step: "SUMMARY",
      detail: summary,
      progress: 100
    }
  });

  await prisma.checklistTask.updateMany({
    where: {
      roomId,
      title: "Agent run complete"
    },
    data: {
      status: "DONE",
      completedAt: new Date()
    }
  });

  if (refutes >= 2 && confidenceLabel(confidenceScore) === Confidence.HIGH && room.status === RoomStatus.INVESTIGATING) {
    await prisma.room.update({
      where: { id: roomId },
      data: {
        status: RoomStatus.PENDING_VERDICT
      }
    });

    await appendAuditLog({
      roomId,
      actorId,
      actorType: "AGENT",
      action: "AGENT_SUGGESTED_PENDING_VERDICT",
      payload: {
        refutingSources: refutes,
        confidence: confidenceLabel(confidenceScore)
      }
    });
  }

  await appendAuditLog({
    roomId,
    actorId,
    actorType: "AGENT",
    action: "AGENT_RUN_COMPLETED",
    payload: {
      evidenceProcessed: savedEvidence.length,
      refutingSources: refutes,
      confidence: confidenceLabel(confidenceScore)
    }
  });

  return {
    blocked: false,
    evidenceProcessed: savedEvidence.length,
    confidence: confidenceLabel(confidenceScore)
  };
}

export async function generateClarityCardForRoom(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      evidence: {
        where: { removedAt: null },
        orderBy: { createdAt: "desc" },
        take: 6
      }
    }
  });

  if (!room || room.status !== RoomStatus.CLOSED || !room.verdict || !room.confidence) {
    throw new Error("Room not eligible for clarity card");
  }

  const topBullets = room.evidence
    .filter((item) => item.stance === Stance.REFUTES || item.stance === Stance.SUPPORTS)
    .slice(0, 3)
    .map((item) => `${item.sourceName}: ${item.snippet}`)
    .slice(0, 3);

  const fallbackClaimShort = room.claimNormalized.slice(0, 120);
  const prompt = `Claim to verify: ${room.claimNormalized}\nSearch results provided: ${JSON.stringify(topBullets)}\nTask: Write a concise max-120-char claim short and a 2-sentence share-safe rebuttal.`;
  const gemini = await callGemini(prompt);

  const claimShort = sanitizeClaimText(gemini?.split("\n")[0] ?? fallbackClaimShort).slice(0, 120);
  const rebuttalText = sanitizeSnippet(
    gemini?.split("\n").slice(1).join(" ") ||
      `Verdict: ${room.verdict}. The available evidence does not support the viral claim as stated.`,
    280
  );

  const cardPath = `/cards/${room.id}.png`;
  const audioPath = env.ELEVENLABS_API_KEY ? `/cards/${room.id}.mp3` : null;
  const qrUrl = `${env.APP_URL}/?room=${room.id}`;

  await prisma.clarityCard.upsert({
    where: { roomId },
    update: {
      claimShort,
      verdict: room.verdict,
      confidence: room.confidence,
      evidenceBullets: topBullets,
      rebuttalText,
      imageUrl: cardPath,
      audioUrl: audioPath,
      qrUrl
    },
    create: {
      roomId,
      claimShort,
      verdict: room.verdict,
      confidence: room.confidence,
      evidenceBullets: topBullets,
      rebuttalText,
      imageUrl: cardPath,
      audioUrl: audioPath,
      qrUrl
    }
  });

  await prisma.room.update({
    where: { id: roomId },
    data: {
      clarityCardUrl: cardPath,
      voiceBriefUrl: audioPath
    }
  });

  await appendAuditLog({
    roomId,
    actorType: "SYSTEM",
    action: "CLARITY_CARD_GENERATED",
    payload: {
      cardPath,
      audioPath
    }
  });

  return {
    cardPath,
    audioPath
  };
}

export function computeWeightedResults(votes: Array<{ verdict: "TRUE" | "FALSE" | "UNCLEAR"; weight: number }>) {
  const totals = {
    TRUE: 0,
    FALSE: 0,
    UNCLEAR: 0
  };

  for (const vote of votes) {
    totals[vote.verdict] += vote.weight;
  }

  const grandTotal = totals.TRUE + totals.FALSE + totals.UNCLEAR || 1;

  return {
    totals,
    percentages: {
      TRUE: Math.round((totals.TRUE / grandTotal) * 100),
      FALSE: Math.round((totals.FALSE / grandTotal) * 100),
      UNCLEAR: Math.round((totals.UNCLEAR / grandTotal) * 100)
    }
  };
}

export function deriveVerdictFromVotes(votes: Array<{ verdict: "TRUE" | "FALSE" | "UNCLEAR"; weight: number }>) {
  const weighted = computeWeightedResults(votes);

  if (weighted.totals.TRUE >= weighted.totals.FALSE && weighted.totals.TRUE >= weighted.totals.UNCLEAR) {
    return "TRUE" as const;
  }

  if (weighted.totals.FALSE >= weighted.totals.TRUE && weighted.totals.FALSE >= weighted.totals.UNCLEAR) {
    return "FALSE" as const;
  }

  return "UNCLEAR" as const;
}
