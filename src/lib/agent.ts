import { GoogleGenerativeAI } from "@google/generative-ai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Confidence, EvidenceType, RoomStatus, Stance } from "@prisma/client";
import { z } from "zod";
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

type AgentAssessment = {
  verdict: "TRUE" | "FALSE" | "UNCLEAR";
  confidence: Confidence;
  summary: string;
};

const claimRewriteSchema = z.object({
  claimNormalized: z.string().min(8).max(260)
});

const queryPlanSchema = z.object({
  queries: z.array(z.string().min(4).max(140)).min(3).max(5)
});

const assessmentSchema = z.object({
  verdict: z.enum(["TRUE", "FALSE", "UNCLEAR"]),
  confidence: z.nativeEnum(Confidence),
  summary: z.string().min(20).max(2000)
});

const clarityCardSchema = z.object({
  claimShort: z.string().min(8).max(120),
  rebuttalText: z.string().min(20).max(320),
  voiceBrief: z.string().min(20).max(420).optional()
});

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

  const preferredModel = process.env.GEMINI_MODEL?.trim() || "gemini-3.1-flash";
  const candidateModels = [preferredModel, "gemini-2.5-flash", "gemini-2.0-flash-exp"];

  let lastError: unknown;

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(`${VERI_AGENT_SYSTEM_PROMPT}\n\n${prompt}`);
      return result.response.text();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function extractJsonPayload(raw: string) {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? raw.match(/```\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    return fenced.trim();
  }

  const objectMatch = raw.match(/\{[\s\S]*\}/);
  const arrayMatch = raw.match(/\[[\s\S]*\]/);

  if (objectMatch && arrayMatch) {
    return objectMatch.index! <= arrayMatch.index! ? objectMatch[0] : arrayMatch[0];
  }

  if (objectMatch) {
    return objectMatch[0];
  }

  if (arrayMatch) {
    return arrayMatch[0];
  }

  return null;
}

async function callGeminiJson<T>(prompt: string, schema: z.ZodType<T>): Promise<T | null> {
  const generated = await callGemini(`${prompt}\nReturn strict JSON only. Do not include markdown.`);

  if (!generated) {
    return null;
  }

  const jsonPayload = extractJsonPayload(generated);
  if (!jsonPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonPayload) as unknown;
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function resolveWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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

  const prompt = `Claim to verify: ${cleaned}
Task: Rewrite this as one concise factual assertion preserving the original meaning.
Output JSON: {"claimNormalized":"..."}`;
  const generated = await callGeminiJson(prompt, claimRewriteSchema);

  if (!generated?.claimNormalized) {
    return {
      blocked: null,
      claimNormalized: cleaned
    };
  }

  return {
    blocked: null,
    claimNormalized: sanitizeClaimText(generated.claimNormalized)
  };
}

async function generateSearchQueries(claimNormalized: string) {
  const prompt = `Claim to verify: ${claimNormalized}
Task: Generate 3 to 5 short web search queries designed to surface high-quality public sources.
Output JSON: {"queries":["...","..."]}`;

  const generated = await callGeminiJson(prompt, queryPlanSchema);

  const fallback = [
    `${claimNormalized} fact check`,
    `${claimNormalized} official statement`,
    `${claimNormalized} verification`
  ];

  const candidate = generated?.queries ?? fallback;
  const normalized = [...new Set(candidate.map((query) => sanitizeClaimText(query)).filter(Boolean))];

  return normalized.slice(0, 5);
}

async function fetchSearchResults(_claimNormalized: string, queries: string[]): Promise<SearchResult[]> {
  if (!env.BRAVE_SEARCH_API_KEY) {
    return [];
  }

  const all = new Map<string, SearchResult>();

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
      const sourceGuard = validateSourceUrl(result.url);
      if (sourceGuard.blocked) {
        continue;
      }

      if (!all.has(result.url)) {
        all.set(result.url, {
          title: sanitizeSnippet(result.title, 140),
          url: result.url,
          snippet: sanitizeSnippet(result.description, 220)
        });
      }
    }
  }

  return Array.from(all.values()).slice(0, 8);
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

function fallbackAssessment(evidenceRows: Array<{ sourceUrl: string; snippet: string; stance: Stance }>): AgentAssessment {
  const counts = {
    SUPPORTS: evidenceRows.filter((row) => row.stance === Stance.SUPPORTS).length,
    REFUTES: evidenceRows.filter((row) => row.stance === Stance.REFUTES).length,
    CONTEXT: evidenceRows.filter((row) => row.stance === Stance.CONTEXT).length
  };

  let verdict: AgentAssessment["verdict"] = "UNCLEAR";
  if (counts.REFUTES > counts.SUPPORTS && counts.REFUTES >= 2) {
    verdict = "FALSE";
  } else if (counts.SUPPORTS > counts.REFUTES && counts.SUPPORTS >= 2) {
    verdict = "TRUE";
  }

  const dominant = Math.max(counts.REFUTES, counts.SUPPORTS, counts.CONTEXT, 1);
  const confidence = confidenceLabel(Math.min(0.95, 0.45 + dominant / Math.max(evidenceRows.length, 1) / 2));

  return {
    verdict,
    confidence,
    summary: [
      `OBSERVATION: Processed ${evidenceRows.length} eligible public sources.`,
      `INFERENCE: Evidence counts -> supports=${counts.SUPPORTS}, refutes=${counts.REFUTES}, context=${counts.CONTEXT}.`,
      `SPECULATION: Additional authoritative reporting may increase certainty.`
    ].join("\n")
  };
}

async function assessEvidence(claim: string, evidenceRows: Array<{ sourceUrl: string; snippet: string; stance: Stance }>) {
  if (!evidenceRows.length) {
    return fallbackAssessment(evidenceRows);
  }

  const prompt = `Claim to verify: ${claim}
Evidence rows (JSON): ${JSON.stringify(evidenceRows.slice(0, 8))}
Task:
1) Determine recommended verdict from evidence: TRUE | FALSE | UNCLEAR.
2) Determine confidence: LOW | MEDIUM | HIGH.
3) Write a concise summary with exactly three lines prefixed OBSERVATION:, INFERENCE:, SPECULATION:.
Output JSON: {"verdict":"TRUE|FALSE|UNCLEAR","confidence":"LOW|MEDIUM|HIGH","summary":"OBSERVATION: ...\\nINFERENCE: ...\\nSPECULATION: ..."}`;

  const generated = await callGeminiJson(prompt, assessmentSchema);
  if (!generated) {
    return fallbackAssessment(evidenceRows);
  }

  return {
    verdict: generated.verdict,
    confidence: generated.confidence,
    summary: sanitizeSnippet(generated.summary, 1800)
  } satisfies AgentAssessment;
}

async function synthesizeVoiceBrief(roomId: string, text: string) {
  if (!env.ELEVENLABS_API_KEY) {
    return null;
  }

  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75
        }
      }),
      signal: controller.signal,
      cache: "no-store"
    });

    if (!response.ok) {
      return null;
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const cardsDir = path.join(process.cwd(), "public", "cards");
    await mkdir(cardsDir, { recursive: true });
    await writeFile(path.join(cardsDir, `${roomId}.mp3`), audioBuffer);

    return `/cards/${roomId}.mp3`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

  if (!env.BRAVE_SEARCH_API_KEY) {
    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: "Brave API key missing. Skipping web retrieval for this run.",
        progress: 30
      }
    });
  } else if (results.length === 0) {
    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: "No eligible public sources returned from Brave for generated queries.",
        progress: 30
      }
    });
  }

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

  const assessment = await assessEvidence(room.claimNormalized, savedEvidence);
  const outputGuard = classifyOutputBlock(assessment.summary);

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

  await prisma.agentEvent.create({
    data: {
      roomId,
      step: "SUMMARY",
      detail: `${assessment.summary}\nVERDICT: ${assessment.verdict} (${assessment.confidence})`,
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

  if (refutes >= 2 && assessment.confidence === Confidence.HIGH && room.status === RoomStatus.INVESTIGATING) {
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
        confidence: assessment.confidence,
        recommendedVerdict: assessment.verdict
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
      confidence: assessment.confidence,
      recommendedVerdict: assessment.verdict
    }
  });

  return {
    blocked: false,
    evidenceProcessed: savedEvidence.length,
    confidence: assessment.confidence,
    recommendedVerdict: assessment.verdict
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
  const prompt = `Claim to verify: ${room.claimNormalized}
Evidence bullets: ${JSON.stringify(topBullets)}
Task:
1) Write claimShort (max 120 chars) suitable for sharing.
2) Write rebuttalText (2 sentences, calm neutral tone, max 280 chars).
3) Write voiceBrief (30-45 second spoken script, max 420 chars).
Output JSON: {"claimShort":"...","rebuttalText":"...","voiceBrief":"..."}`;

  const generated = await resolveWithTimeout(callGeminiJson(prompt, clarityCardSchema), 20000, null);

  const claimShort = sanitizeClaimText(generated?.claimShort ?? fallbackClaimShort).slice(0, 120);
  const rebuttalText = sanitizeSnippet(
    generated?.rebuttalText || `Verdict: ${room.verdict}. The available evidence does not support the viral claim as stated.`,
    280
  );

  const voiceBriefScript = sanitizeSnippet(generated?.voiceBrief ?? rebuttalText, 420);
  const audioPath = await resolveWithTimeout(synthesizeVoiceBrief(room.id, voiceBriefScript), 9000, null);

  const cardPath = `/cards/${room.id}.png`;
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
