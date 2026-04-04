import { GoogleGenerativeAI } from "@google/generative-ai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Confidence, EvidenceType, GlobalRole, RoomMessageKind, RoomStatus, Stance } from "@prisma/client";
import { z } from "zod";
import { appendAuditLog } from "@/lib/audit";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { classifyOutputBlock, classifyPromptBlock, validateSourceUrl } from "@/lib/security/agent-guard";
import { RateLimitError, enforceRateLimit } from "@/lib/security/rate-limit";
import { sanitizeChatBody, sanitizeClaimText, sanitizeSnippet } from "@/lib/security/sanitize";
import { publishSpacetimeEvent } from "@/lib/spacetime";

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

type DuckDuckGoTopic = {
  FirstURL?: string;
  Text?: string;
  Topics?: DuckDuckGoTopic[];
};

type DuckDuckGoResponse = {
  AbstractURL?: string;
  AbstractText?: string;
  Heading?: string;
  Results?: DuckDuckGoTopic[];
  RelatedTopics?: DuckDuckGoTopic[];
};

type AgentAssessment = {
  verdict: "TRUE" | "FALSE" | "UNCLEAR";
  confidence: Confidence;
  summary: string;
};

type AgentChatProof = {
  evidenceId: string;
  body: string;
};

type AgentChatResponse = {
  blocked: boolean;
  rule?: string;
  replyText: string;
  proofNotes: AgentChatProof[];
};

type AgentPipelineOptions = {
  focusQuestion?: string;
  pinTopProofs?: boolean;
};

type PinnedProofCandidate = {
  id: string;
  sourceName: string;
  sourceUrl: string;
  snippet: string;
  stance: Stance;
  agentConfidence: number | null;
};

type SearchProvider = "gemini-grounding" | "brave" | "duckduckgo" | "none";

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

const evidenceClassificationSchema = z.object({
  stance: z.nativeEnum(Stance),
  type: z.nativeEnum(EvidenceType),
  confidence: z.number().min(0).max(1)
});

const chatNarrativeSchema = z.object({
  answer: z.string().min(24).max(2200)
});

const groundedSourcesSchema = z.object({
  sources: z
    .array(
      z.object({
        title: z.string().min(2).max(200),
        url: z.string().url(),
        snippet: z.string().min(12).max(500)
      })
    )
    .min(1)
    .max(8)
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

  if (lastError) {
    return null;
  }

  return null;
}

async function callGeminiGrounded(prompt: string) {
  if (!env.GEMINI_API_KEY) {
    return null;
  }

  const modelName = process.env.GEMINI_MODEL?.trim() || "gemini-3.1-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: VERI_AGENT_SYSTEM_PROMPT }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2
        }
      }),
      cache: "no-store"
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? "").join("\n").trim();

    return text || null;
  } catch {
    return null;
  }
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

async function generateSearchQueries(claimNormalized: string, focusQuestion?: string) {
  const prompt = `Claim to verify: ${claimNormalized}
User focus question (optional): ${focusQuestion || "none"}
Task: Generate 3 to 5 short web search queries designed to surface high-quality public sources and address the user focus when provided.
Output JSON: {"queries":["...","..."]}`;

  const generated = await callGeminiJson(prompt, queryPlanSchema);

  const fallback = [
    `${claimNormalized} fact check`,
    `${claimNormalized} official statement`,
    `${claimNormalized} verification`,
    focusQuestion ? `${claimNormalized} ${focusQuestion}` : ""
  ];

  const candidate = generated?.queries ?? fallback;
  const normalized = [...new Set(candidate.map((query) => sanitizeClaimText(query)).filter(Boolean))];

  return normalized.slice(0, 5);
}

function collectDuckDuckGoTopics(topics: DuckDuckGoTopic[] | undefined, collected: DuckDuckGoTopic[]) {
  if (!topics?.length) {
    return;
  }

  for (const topic of topics) {
    if (topic.Topics?.length) {
      collectDuckDuckGoTopics(topic.Topics, collected);
      continue;
    }

    collected.push(topic);
  }
}

async function fetchSearchResultsWithGeminiGrounding(
  claimNormalized: string,
  queries: string[],
  focusQuestion?: string
): Promise<SearchResult[]> {
  const prompt = `Claim to verify: ${claimNormalized}
User focus question (optional): ${focusQuestion || "none"}
Candidate query hints: ${JSON.stringify(queries)}
Task: Use Google Search to find up-to-date public sources directly relevant to the claim and user focus.
Return strict JSON only with this shape:
{"sources":[{"title":"...","url":"https://...","snippet":"..."}]}
Rules:
- 4 to 8 sources
- Prefer authoritative/reporting sources
- Include mixed evidence (supports/refutes/context) when available
- No private social profile links`;

  const raw = await callGeminiGrounded(prompt);
  if (!raw) {
    return [];
  }

  const payload = extractJsonPayload(raw);
  if (!payload) {
    return [];
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    const validated = groundedSourcesSchema.safeParse(parsed);

    if (!validated.success) {
      return [];
    }

    const deduped = new Map<string, SearchResult>();
    for (const item of validated.data.sources) {
      const guard = validateSourceUrl(item.url);
      if (guard.blocked || deduped.has(item.url)) {
        continue;
      }

      deduped.set(item.url, {
        title: sanitizeSnippet(item.title, 140),
        url: item.url,
        snippet: sanitizeSnippet(item.snippet, 220)
      });
    }

    return Array.from(deduped.values()).slice(0, 8);
  } catch {
    return [];
  }
}

async function fetchSearchResults(
  claimNormalized: string,
  queries: string[],
  focusQuestion?: string
): Promise<{ provider: SearchProvider; results: SearchResult[] }> {
  const grounded = await fetchSearchResultsWithGeminiGrounding(claimNormalized, queries, focusQuestion);
  if (grounded.length) {
    return {
      provider: "gemini-grounding",
      results: grounded
    };
  }

  const all = new Map<string, SearchResult>();

  if (!env.BRAVE_SEARCH_API_KEY) {
    for (const query of queries) {
      const response = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
        {
          headers: {
            Accept: "application/json"
          },
          cache: "no-store"
        }
      );

      if (!response.ok) {
        continue;
      }

      const data = (await response.json()) as DuckDuckGoResponse;
      const topics: DuckDuckGoTopic[] = [];

      if (data.AbstractURL && data.AbstractText) {
        topics.push({
          FirstURL: data.AbstractURL,
          Text: data.AbstractText
        });
      }

      topics.push(...(data.Results ?? []));
      collectDuckDuckGoTopics(data.RelatedTopics, topics);

      for (const topic of topics) {
        if (!topic.FirstURL || !topic.Text) {
          continue;
        }

        const sourceGuard = validateSourceUrl(topic.FirstURL);
        if (sourceGuard.blocked || all.has(topic.FirstURL)) {
          continue;
        }

        all.set(topic.FirstURL, {
          title: sanitizeSnippet(data.Heading || sourceNameFromUrl(topic.FirstURL), 140),
          url: topic.FirstURL,
          snippet: sanitizeSnippet(topic.Text, 220)
        });
      }
    }

    return {
      provider: all.size ? "duckduckgo" : "none",
      results: Array.from(all.values()).slice(0, 8)
    };
  }

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

  return {
    provider: all.size ? "brave" : "none",
    results: Array.from(all.values()).slice(0, 8)
  };
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
  if (!evidenceRows.length) {
    return {
      verdict: "UNCLEAR",
      confidence: Confidence.LOW,
      summary: [
        "OBSERVATION: No eligible public sources are available in this room yet.",
        "INFERENCE: There is not enough evidence to support or refute the claim.",
        "SPECULATION: Add evidence links or ask the agent to refresh sources."
      ].join("\n")
    };
  }

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

function evidenceRankForPrompt(stance: Stance, promptLower: string) {
  const asksRefute = /(refute|debunk|false|wrong|counter)/.test(promptLower);
  const asksSupport = /(support|confirm|true|prove|back up)/.test(promptLower);

  if (asksRefute) {
    if (stance === Stance.REFUTES) return 0;
    if (stance === Stance.CONTEXT) return 1;
    return 2;
  }

  if (asksSupport) {
    if (stance === Stance.SUPPORTS) return 0;
    if (stance === Stance.CONTEXT) return 1;
    return 2;
  }

  if (stance === Stance.REFUTES) return 0;
  if (stance === Stance.SUPPORTS) return 1;
  return 2;
}

function formatRefreshNote(refreshState: "skipped" | "ran" | "cooldown" | "failed") {
  if (refreshState === "ran") {
    return "I also refreshed the investigation before replying.";
  }

  if (refreshState === "cooldown") {
    return "I used current room evidence because the refresh endpoint is cooling down.";
  }

  if (refreshState === "failed") {
    return "I could not refresh sources right now, so this is based on current room evidence.";
  }

  return null;
}

type StanceLinkRow = {
  sourceName: string;
  sourceUrl: string;
  stance: Stance;
};

function dedupeStanceLinks(rows: StanceLinkRow[]) {
  const seen = new Set<string>();
  const deduped: StanceLinkRow[] = [];

  for (const row of rows) {
    if (seen.has(row.sourceUrl)) {
      continue;
    }

    seen.add(row.sourceUrl);
    deduped.push(row);
  }

  return deduped;
}

function formatLinkBucket(title: string, rows: StanceLinkRow[]) {
  if (!rows.length) {
    return `${title}: none found in the latest grounded run.`;
  }

  return [
    `${title}:`,
    ...rows.map((row, index) => `${index + 1}. ${row.sourceName} - ${row.sourceUrl}`)
  ].join("\n");
}

function buildStanceGroupedLinks(rows: StanceLinkRow[]) {
  const deduped = dedupeStanceLinks(rows);

  const supports = deduped.filter((row) => row.stance === Stance.SUPPORTS).slice(0, 3);
  const refutes = deduped.filter((row) => row.stance === Stance.REFUTES).slice(0, 3);
  const context = deduped.filter((row) => row.stance === Stance.CONTEXT).slice(0, 2);

  return [
    formatLinkBucket("Supportive links", supports),
    formatLinkBucket("Refuting links", refutes),
    formatLinkBucket("Unclear/context links", context)
  ].join("\n\n");
}

async function classifyEvidenceWithGemini(
  claimNormalized: string,
  source: { title: string; url: string; snippet: string },
  focusQuestion?: string
) {
  const fallback = classifyStance(claimNormalized, source.snippet);

  const prompt = `Claim to verify: ${claimNormalized}
User focus question (optional): ${focusQuestion || "none"}
Source title: ${source.title}
Source URL: ${source.url}
Source snippet: ${source.snippet}
Task:
1) Classify whether this source SUPPORTS, REFUTES, or gives CONTEXT for the claim.
2) Choose evidence type OBSERVATION, INFERENCE, or SPECULATION.
3) Assign confidence as a number between 0 and 1.
Output JSON: {"stance":"SUPPORTS|REFUTES|CONTEXT","type":"OBSERVATION|INFERENCE|SPECULATION","confidence":0.0}`;

  const generated = await callGeminiJson(prompt, evidenceClassificationSchema);

  if (!generated) {
    return fallback;
  }

  return {
    stance: generated.stance,
    type: generated.type,
    confidence: generated.confidence
  };
}

async function buildGeminiChatNarrative(
  claimNormalized: string,
  question: string,
  evidenceRows: Array<{ sourceName: string; sourceUrl: string; stance: Stance; snippet: string }>
) {
  if (!evidenceRows.length) {
    return null;
  }

  const compactRows = evidenceRows.slice(0, 5).map((item, index) => ({
    id: index + 1,
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    stance: item.stance,
    snippet: item.snippet
  }));

  const prompt = `Claim to verify: ${claimNormalized}
User question: ${question || "Give your latest investigative take on this rumour."}
Evidence rows JSON: ${JSON.stringify(compactRows)}
Task:
1) Answer naturally like an investigative assistant.
2) Do NOT output raw evidence counts.
3) Reference evidence IDs like [1], [2], [3] when making claims.
4) Mention uncertainty when evidence is incomplete.
Output JSON: {"answer":"..."}`;

  const generated = await callGeminiJson(prompt, chatNarrativeSchema);
  if (!generated?.answer) {
    return null;
  }

  const outputGuard = classifyOutputBlock(generated.answer);
  if (outputGuard.blocked) {
    return null;
  }

  return sanitizeSnippet(generated.answer, 1500);
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

    const audioBuffer = new Uint8Array(await response.arrayBuffer());
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

function pinLabelForStance(stance: Stance) {
  if (stance === Stance.SUPPORTS) {
    return "SUPPORTS";
  }

  if (stance === Stance.REFUTES) {
    return "REFUTES";
  }

  return "UNCLEAR";
}

function selectPinnedProofCandidates(rows: PinnedProofCandidate[]) {
  const stanceOrder = [Stance.SUPPORTS, Stance.REFUTES, Stance.CONTEXT];
  const selected: PinnedProofCandidate[] = [];

  for (const stance of stanceOrder) {
    const best = rows
      .filter((item) => item.stance === stance)
      .sort((a, b) => (b.agentConfidence ?? 0) - (a.agentConfidence ?? 0))[0];

    if (best) {
      selected.push(best);
    }
  }

  return selected;
}

async function pinProofMessagesForRoom(
  roomId: string,
  evidenceRows: PinnedProofCandidate[],
  actorId?: string
) {
  const candidates = selectPinnedProofCandidates(evidenceRows);
  if (!candidates.length) {
    return 0;
  }

  const agentUser = await prisma.user.upsert({
    where: { email: "agent@veriwire.system" },
    update: {
      name: "VeriAgent",
      role: GlobalRole.MODERATOR,
      contributorScore: 2.0
    },
    create: {
      email: "agent@veriwire.system",
      name: "VeriAgent",
      role: GlobalRole.MODERATOR,
      contributorScore: 2.0
    }
  });

  let pinnedCount = 0;

  for (const evidence of candidates) {
    const alreadyPinned = await prisma.roomMessage.findFirst({
      where: {
        roomId,
        userId: agentUser.id,
        kind: RoomMessageKind.PROOF_NOTE,
        evidenceId: evidence.id
      },
      select: {
        id: true
      }
    });

    if (alreadyPinned) {
      continue;
    }

    const pinLabel = pinLabelForStance(evidence.stance);
    const body = sanitizeChatBody(
      `Pinned ${pinLabel} proof: ${evidence.sourceName} says ${sanitizeSnippet(evidence.snippet, 220)} Source: ${evidence.sourceUrl}`,
      360
    );

    const proofMessage = await prisma.roomMessage.create({
      data: {
        roomId,
        userId: agentUser.id,
        body,
        kind: RoomMessageKind.PROOF_NOTE,
        evidenceId: evidence.id
      },
      select: {
        id: true,
        userId: true,
        kind: true,
        evidenceId: true,
        body: true,
        createdAt: true
      }
    });

    await publishSpacetimeEvent({
      roomId,
      event: "room.message.created",
      data: {
        id: proofMessage.id,
        userId: proofMessage.userId,
        kind: proofMessage.kind,
        evidenceId: proofMessage.evidenceId,
        bodyPreview: proofMessage.body.slice(0, 280),
        createdAt: proofMessage.createdAt.toISOString()
      },
      createdAt: proofMessage.createdAt.toISOString()
    });

    pinnedCount += 1;
  }

  if (pinnedCount > 0) {
    await appendAuditLog({
      roomId,
      actorId,
      actorType: "SYSTEM",
      action: "AGENT_PROOFS_PINNED",
      payload: {
        pinnedCount
      }
    });
  }

  return pinnedCount;
}

export async function runAgentPipeline(roomId: string, actorId?: string, options?: AgentPipelineOptions) {
  await enforceRateLimit({
    key: `agent-run:${roomId}`,
    limit: 4,
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

  const focusQuestion = sanitizeSnippet(options?.focusQuestion ?? "", 240);
  const queries = await generateSearchQueries(room.claimNormalized, focusQuestion || undefined);

  await prisma.agentEvent.create({
    data: {
      roomId,
      step: "QUERY_GENERATION",
      detail: `Generated ${queries.length} queries`,
      progress: 20
    }
  });

  const { provider, results } = await fetchSearchResults(
    room.claimNormalized,
    queries,
    focusQuestion || undefined
  );

  if (provider === "gemini-grounding") {
    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: "Using Gemini grounding search for this run.",
        progress: 30
      }
    });
  }

  if (provider === "duckduckgo") {
    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: "Gemini grounding unavailable. Using DuckDuckGo fallback search for this run.",
        progress: 30
      }
    });
  }

  if (provider === "brave") {
    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: "Using Brave search for this run.",
        progress: 30
      }
    });
  }

  if (results.length === 0) {
    const noResultsDetail =
      provider === "gemini-grounding"
        ? "Gemini grounding returned no eligible public sources for generated queries."
        : provider === "brave"
          ? "No eligible public sources returned from Brave for generated queries."
          : provider === "duckduckgo"
            ? "No eligible public sources returned from DuckDuckGo fallback for generated queries."
            : "No eligible public sources were returned by available search providers.";

    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: noResultsDetail,
        progress: 30
      }
    });
  }

  const savedEvidence: PinnedProofCandidate[] = [];

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

    const stanceClass = await classifyEvidenceWithGemini(
      room.claimNormalized,
      {
        title: result.title,
        url: result.url,
        snippet
      },
      focusQuestion || undefined
    );

    const existingAgentEvidence = await prisma.evidence.findFirst({
      where: {
        roomId,
        sourceUrl: result.url,
        submittedBy: "AGENT",
        removedAt: null
      },
      select: {
        id: true
      }
    });

    const saved = existingAgentEvidence
      ? await prisma.evidence.update({
          where: { id: existingAgentEvidence.id },
          data: {
            sourceName: sourceNameFromUrl(result.url),
            sourceFaviconUrl: `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(result.url)}`,
            snippet,
            stance: stanceClass.stance,
            type: stanceClass.type,
            agentConfidence: stanceClass.confidence
          },
          select: {
            id: true,
            sourceName: true,
            sourceUrl: true,
            snippet: true,
            stance: true,
            agentConfidence: true
          }
        })
      : await prisma.evidence.create({
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
          },
          select: {
            id: true,
            sourceName: true,
            sourceUrl: true,
            snippet: true,
            stance: true,
            agentConfidence: true
          }
        });

    savedEvidence.push(saved);

    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: `Processed ${index + 1}/${results.length} sources`,
        progress: Math.min(95, 30 + index * 10)
      }
    });
  }

  let assessmentRows: Array<{ sourceUrl: string; snippet: string; stance: Stance }> = savedEvidence.map((item) => ({
    sourceUrl: item.sourceUrl,
    snippet: item.snippet,
    stance: item.stance
  }));

  if (!assessmentRows.length) {
    const existingEvidence = await prisma.evidence.findMany({
      where: {
        roomId,
        removedAt: null
      },
      orderBy: {
        createdAt: "desc"
      },
      take: 8,
      select: {
        sourceUrl: true,
        snippet: true,
        stance: true
      }
    });

    assessmentRows = existingEvidence;
  }

  const assessment = await assessEvidence(room.claimNormalized, assessmentRows);
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

  const refutes = assessmentRows.filter((row) => row.stance === Stance.REFUTES).length;

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

  let pinnedProofs = 0;

  if (options?.pinTopProofs) {
    const rowsForPinning =
      savedEvidence.length > 0
        ? savedEvidence
        : await prisma.evidence.findMany({
            where: {
              roomId,
              submittedBy: "AGENT",
              removedAt: null
            },
            orderBy: {
              createdAt: "desc"
            },
            take: 8,
            select: {
              id: true,
              sourceName: true,
              sourceUrl: true,
              snippet: true,
              stance: true,
              agentConfidence: true
            }
          });

    pinnedProofs = await pinProofMessagesForRoom(roomId, rowsForPinning, actorId);

    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "PIN_PROOFS",
        detail: pinnedProofs
          ? `Pinned ${pinnedProofs} proof notes across supports/refutes/unclear buckets.`
          : "No new proof notes were pinned for this run.",
        progress: 98
      }
    });
  }

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
    pinnedProofs,
    confidence: assessment.confidence,
    recommendedVerdict: assessment.verdict
  };
}

export async function generateAgentChatResponse(roomId: string, questionRaw: string, actorId?: string): Promise<AgentChatResponse> {
  const question = sanitizeSnippet(questionRaw || "", 320);
  const guard = classifyPromptBlock(question);

  if (guard.blocked) {
    return {
      blocked: true,
      rule: guard.rule,
      replyText: `I could not process that question due to safety policy (${guard.rule}).`,
      proofNotes: []
    };
  }

  const promptLower = question.toLowerCase();

  let refreshState: "skipped" | "ran" | "cooldown" | "failed" = "skipped";

  try {
    await runAgentPipeline(roomId, actorId, {
      focusQuestion: question
    });
    refreshState = "ran";
  } catch (error) {
    refreshState = error instanceof RateLimitError ? "cooldown" : "failed";
  }

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      claimNormalized: true,
      evidence: {
        where: { removedAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          sourceName: true,
          sourceUrl: true,
          snippet: true,
          stance: true,
          createdAt: true
        }
      }
    }
  });

  if (!room) {
    throw new Error("Room not found");
  }

  const rowsForAssessment = room.evidence.map((item) => ({
    sourceUrl: item.sourceUrl,
    snippet: item.snippet,
    stance: item.stance
  }));

  const assessment = await assessEvidence(room.claimNormalized, rowsForAssessment);

  const rankedEvidence = [...room.evidence].sort((a, b) => {
    const rankDiff = evidenceRankForPrompt(a.stance, promptLower) - evidenceRankForPrompt(b.stance, promptLower);

    if (rankDiff !== 0) {
      return rankDiff;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const selectedProofs = rankedEvidence.slice(0, 4);
  const narrative = await buildGeminiChatNarrative(
    room.claimNormalized,
    question,
    selectedProofs.map((item) => ({
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      stance: item.stance,
      snippet: item.snippet
    }))
  );

  const fallbackEvidenceDetail = selectedProofs.length
    ? `The strongest current signals come from ${selectedProofs
        .slice(0, 2)
        .map((item) => `${item.sourceName} (${item.stance.toLowerCase()})`)
        .join(" and ")}.`
    : "I still need public sources in this room to make a grounded call.";

  const fallbackNarrative = !genAI
    ? `Gemini agent is not configured (missing GEMINI_API_KEY). ${fallbackEvidenceDetail}`
    : `My current take is ${assessment.verdict} with ${assessment.confidence} confidence. ${fallbackEvidenceDetail}`;

  const sourceSummary = buildStanceGroupedLinks(
    room.evidence.map((item) => ({
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      stance: item.stance
    }))
  );

  const providerNote = env.GEMINI_API_KEY
    ? "Web retrieval mode: Gemini grounding search (with automatic provider fallback if needed)."
    : !env.BRAVE_SEARCH_API_KEY
      ? "Using DuckDuckGo fallback search because BRAVE_SEARCH_API_KEY is missing. Coverage may be narrower than Brave."
      : null;

  const refreshNote = formatRefreshNote(refreshState);
  const opinionText = [narrative ?? fallbackNarrative, sourceSummary, providerNote, refreshNote]
    .filter(Boolean)
    .join("\n\n");

  const wantsExplicitProofs = /\b(proof|proofs|evidence|source|sources|cite|citations|why)\b/.test(promptLower);
  const proofNotes = wantsExplicitProofs
    ? selectedProofs.slice(0, 2).map((item, index) => ({
        evidenceId: item.id,
        body: sanitizeChatBody(
          `Proof ${index + 1}: ${item.sourceName} (${item.stance}) says ${sanitizeSnippet(item.snippet, 200)} Source: ${item.sourceUrl}`,
          360
        )
      }))
    : [];

  return {
    blocked: false,
    replyText: sanitizeChatBody(opinionText, 1900),
    proofNotes
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
