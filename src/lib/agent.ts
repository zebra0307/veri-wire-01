import { GoogleGenerativeAI } from "@google/generative-ai";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Confidence, EvidenceType, GlobalRole, RoomMessageKind, RoomStatus, Stance } from "@prisma/client";
import { z } from "zod";
import { appendAuditLog } from "@/lib/audit";
import {
  buildVeriWireAgentPlan,
  isArmoriqConfigured,
  requestArmorIQIntentToken
} from "@/lib/armoriq";
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

type SearchProvider = "gemini-grounding" | "none";

const MAX_SEARCH_QUERIES = 7;
const MAX_FETCHED_SOURCES = 24;
const MAX_ASSESSMENT_ROWS = 20;
const DEFAULT_GEMINI_GROUNDING_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-3-flash-preview"
];
const DEFAULT_GEMINI_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-3-flash-preview",
  "gemini-2.5-pro"
];
const GROUNDING_QUOTA_COOLDOWN_MS = 60 * 60 * 1000;

const claimRewriteSchema = z.object({
  claimNormalized: z.string().min(8).max(260)
});

const queryPlanSchema = z.object({
  queries: z.array(z.string().min(4).max(140)).min(4).max(MAX_SEARCH_QUERIES)
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

const linkUnderstandingSchema = z.object({
  summaries: z
    .array(
      z.object({
        sourceUrl: z.string().url(),
        summary: z.string().min(12).max(300)
      })
    )
    .min(1)
    .max(8)
});

const groundedSourcesSchema = z.object({
  sources: z
    .array(
      z.object({
        title: z.string().min(1).max(500),
        url: z.string().url(),
        snippet: z.string().min(1).max(2000)
      })
    )
    .min(1)
    .max(MAX_FETCHED_SOURCES * 3)
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

function isGroundingRedirectHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase() === "vertexaisearch.cloud.google.com";
  } catch {
    return false;
  }
}

function extractCanonicalSourceUrlFromHtml(html: string, currentUrl: string) {
  const candidates = new Set<string>();

  const addCandidate = (value?: string | null) => {
    if (!value) {
      return;
    }

    let candidate = value.trim();
    if (!candidate) {
      return;
    }

    candidate = candidate.replace(/["'<>\s]+$/g, "");

    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Keep original candidate when decoding fails.
    }

    if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) {
      return;
    }

    candidates.add(candidate);
  };

  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  addCandidate(canonicalMatch?.[1]);

  const ogUrlMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
  addCandidate(ogUrlMatch?.[1]);

  const metaRefreshMatch = html.match(/http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i);
  addCandidate(metaRefreshMatch?.[1]);

  // Some redirect pages expose target URL in query parameters.
  try {
    const parsed = new URL(currentUrl);
    addCandidate(parsed.searchParams.get("url"));
    addCandidate(parsed.searchParams.get("target"));
    addCandidate(parsed.searchParams.get("dest"));
    addCandidate(parsed.searchParams.get("redirect"));
  } catch {
    // Ignore malformed URL and continue with HTML-based extraction.
  }

  // Script-based redirect targets like window.location = "https://..."
  const locationMatches = html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/gi) ?? [];
  for (const match of locationMatches) {
    const urlMatch = match.match(/https?:\/\/[^"']+/i)?.[0];
    addCandidate(urlMatch);
  }

  // Structured payloads may contain a target URL field.
  const jsonUrlMatches = html.match(/"(?:url|target|destination|canonicalUrl)"\s*:\s*"([^"]+)"/gi) ?? [];
  for (const match of jsonUrlMatches) {
    const raw = match.match(/"(?:url|target|destination|canonicalUrl)"\s*:\s*"([^"]+)"/i)?.[1];
    if (raw) {
      addCandidate(raw.replace(/\\\//g, "/").replace(/\\u0026/g, "&"));
    }
  }

  for (const candidate of candidates) {
    if (isGroundingRedirectHost(candidate)) {
      continue;
    }

    const guard = validateSourceUrl(candidate);
    if (guard.blocked) {
      continue;
    }

    return candidate;
  }

  return currentUrl;
}

const relevanceStopwords = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "because",
  "before",
  "being",
  "between",
  "claim",
  "from",
  "have",
  "into",
  "just",
  "more",
  "most",
  "news",
  "none",
  "only",
  "other",
  "over",
  "said",
  "same",
  "some",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would"
]);

const broadEntityTokens = new Set(["america", "country", "government", "india", "state", "states", "usa", "world"]);

function normalizeRelevanceText(text: string) {
  return text
    .toLowerCase()
    .replace(/united states of america|united states|u\.s\.a\.|u\.s\./g, " usa ")
    .replace(/world\s+war\s*(iii|3)/g, " ww3 ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForRelevance(text: string) {
  const normalized = normalizeRelevanceText(text);
  if (!normalized) {
    return new Set<string>();
  }

  const tokens = normalized
    .split(" ")
    .filter((token) => token.length >= 3 && !relevanceStopwords.has(token));

  return new Set(tokens);
}

function isLikelyRelevantSource(
  claimNormalized: string,
  source: { title: string; url: string; snippet: string },
  focusQuestion?: string
) {
  const claimTokens = tokenizeForRelevance(`${claimNormalized} ${focusQuestion ?? ""}`);
  if (!claimTokens.size) {
    return true;
  }

  const sourceTokens = tokenizeForRelevance(`${source.title} ${source.snippet} ${source.url}`);
  let overlap = 0;
  for (const token of claimTokens) {
    if (sourceTokens.has(token)) {
      overlap += 1;
    }
  }

  const strongClaimTokens = [...claimTokens].filter((token) => token.length >= 4 && !broadEntityTokens.has(token));
  if (strongClaimTokens.length > 0 && strongClaimTokens.every((token) => !sourceTokens.has(token))) {
    return false;
  }

  return overlap >= 1;
}

function normalizeGeminiModelName(modelName: string) {
  return modelName.trim().replace(/^models\//i, "");
}

function hasExplicitGeminiModelConfig() {
  return Boolean(process.env.GEMINI_MODEL?.trim() || process.env.GEMINI_MODEL_FALLBACKS?.trim());
}

function isGeminiGroundingCapableModel(modelName: string) {
  return normalizeGeminiModelName(modelName).toLowerCase().startsWith("gemini-");
}

function isGeminiQuotaOrRateLimitMessage(detail: string | null | undefined) {
  if (!detail) {
    return false;
  }

  return /(\b429\b|resource_exhausted|quota|rate[\s-]?limit|too many requests|exceeded your current quota)/i.test(detail);
}

function summarizeGroundingFailure(detail: string) {
  if (isGeminiQuotaOrRateLimitMessage(detail)) {
    return "Gemini grounding quota/rate limit reached. Web source refresh is temporarily unavailable until quota resets.";
  }

  return `Gemini grounding could not return sources: ${sanitizeSnippet(detail, 220)}`;
}

function usesLegacySearchRetrievalTool(modelName: string) {
  const n = normalizeGeminiModelName(modelName).toLowerCase();
  return /^gemini-1\./.test(n);
}

function buildGroundingTools(modelName: string) {
  if (usesLegacySearchRetrievalTool(modelName)) {
    return [
      {
        google_search_retrieval: {
          dynamic_retrieval_config: {
            mode: "MODE_DYNAMIC",
            dynamic_threshold: 0.3
          }
        }
      }
    ];
  }
  return [{ google_search: {} }];
}

function getGeminiCandidateModels() {
  const explicitPreferred = normalizeGeminiModelName(process.env.GEMINI_MODEL?.trim() ?? "");
  const preferredModel = normalizeGeminiModelName(process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash");
  const envFallbacks = (process.env.GEMINI_MODEL_FALLBACKS ?? "")
    .split(",")
    .map((value) => normalizeGeminiModelName(value))
    .filter(Boolean);

  if (hasExplicitGeminiModelConfig()) {
    const configured = [...new Set([explicitPreferred, ...envFallbacks])].filter(Boolean);
    return configured.length ? configured : [preferredModel];
  }

  const defaults = DEFAULT_GEMINI_FALLBACK_MODELS.map((model) => normalizeGeminiModelName(model));

  return [...new Set([preferredModel, ...envFallbacks, ...defaults])].filter(Boolean);
}

function getGeminiGroundingCandidateModels() {
  const configured = getGeminiCandidateModels().filter((model) => isGeminiGroundingCapableModel(model));

  if (hasExplicitGeminiModelConfig()) {
    return configured;
  }

  // Without explicit model config, include known grounding defaults.
  const candidates = [...new Set([...configured, ...DEFAULT_GEMINI_GROUNDING_MODELS])];

  if (!candidates.length) {
    return [...DEFAULT_GEMINI_GROUNDING_MODELS];
  }

  return candidates;
}

function isLikelyErrorSnippet(snippet: string) {
  if (!snippet) {
    return true;
  }

  const errorMarker =
    /\b(error page|access denied|forbidden|request blocked|captcha|verify you are human|page not found|404 not found|please enable javascript|cloudflare)\b/i;
  const nutritionSignal = /\b(protein|fat|nutrition|calorie|carb|serving|grams?)\b/i;

  return errorMarker.test(snippet) && !nutritionSignal.test(snippet);
}

async function callGemini(prompt: string) {
  if (!genAI) {
    return null;
  }

  const candidateModels = getGeminiCandidateModels();

  let lastError: unknown;

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(`${VERI_AGENT_SYSTEM_PROMPT}\n\n${prompt}`);
      return result.response.text();
    } catch (error) {
      lastError = error;

      const detail = sanitizeSnippet(error instanceof Error ? error.message : String(error), 240);
      if (isGeminiQuotaOrRateLimitMessage(detail)) {
        break;
      }
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

  const candidateModels = getGeminiGroundingCandidateModels();
  if (!candidateModels.length) {
    return {
      text: null,
      metadataSources: [],
      errorDetail: "Configured model set does not include a grounding-capable Gemini model."
    };
  }

  let lastErrorDetail: string | null = null;

  const parseGroundingMetadataSources = (payload: {
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{
          web?: {
            title?: string;
            uri?: string;
          };
        }>;
        groundingSupports?: Array<{
          segment?: {
            text?: string;
          };
          groundingChunkIndices?: number[];
        }>;
      };
      citationMetadata?: {
        citationSources?: Array<{
          uri?: string;
          title?: string;
        }>;
      };
    }>;
  }) => {
    const deduped = new Map<string, SearchResult>();

    const candidates = payload.candidates ?? [];
    for (const candidate of candidates) {
      const chunks = candidate.groundingMetadata?.groundingChunks ?? [];
      const supports = candidate.groundingMetadata?.groundingSupports ?? [];

      const snippetsByChunk = new Map<number, string[]>();
      for (const support of supports) {
        const segmentText = sanitizeSnippet(support.segment?.text ?? "", 220);
        if (!segmentText) {
          continue;
        }

        for (const chunkIndex of support.groundingChunkIndices ?? []) {
          const existing = snippetsByChunk.get(chunkIndex) ?? [];
          if (!existing.includes(segmentText)) {
            existing.push(segmentText);
          }
          snippetsByChunk.set(chunkIndex, existing);
        }
      }

      for (const [index, chunk] of chunks.entries()) {
        const url = chunk.web?.uri ?? "";
        if (!url || deduped.has(url)) {
          continue;
        }

        const guard = validateSourceUrl(url);
        if (guard.blocked) {
          continue;
        }

        const fallbackName = sourceNameFromUrl(url);
        const title = sanitizeSnippet(chunk.web?.title ?? fallbackName, 140) || fallbackName;
        const joinedSnippets = (snippetsByChunk.get(index) ?? []).join(" ").trim();
        const snippet =
          sanitizeSnippet(joinedSnippets, 220) ||
          sanitizeSnippet(`Grounded source captured for ${fallbackName}.`, 220);

        deduped.set(url, {
          title,
          url,
          snippet
        });
      }

      for (const citation of candidate.citationMetadata?.citationSources ?? []) {
        const url = citation.uri ?? "";
        if (!url || deduped.has(url)) {
          continue;
        }

        const guard = validateSourceUrl(url);
        if (guard.blocked) {
          continue;
        }

        const fallbackName = sourceNameFromUrl(url);
        const title = sanitizeSnippet(citation.title ?? fallbackName, 140) || fallbackName;
        const snippet = sanitizeSnippet(`Grounded source captured for ${fallbackName}.`, 220);

        deduped.set(url, {
          title,
          url,
          snippet
        });
      }
    }

    return Array.from(deduped.values());
  };

  for (const modelName of candidateModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `${VERI_AGENT_SYSTEM_PROMPT}\n\n${prompt}` }]
            }
          ],
          tools: buildGroundingTools(modelName),
          generationConfig: {
            temperature: 0.2
          }
        }),
        signal: controller.signal,
        cache: "no-store"
      });

      if (!response.ok) {
        const responseText = await response.text();
        let errorDetail = `Gemini grounding request failed with status ${response.status}.`;

        try {
          const payload = JSON.parse(responseText) as {
            error?: {
              message?: string;
            };
          };
          if (payload.error?.message) {
            errorDetail = payload.error.message;
          }
        } catch {
          if (responseText.trim()) {
            errorDetail = responseText.trim();
          }
        }

        lastErrorDetail = sanitizeSnippet(errorDetail, 240);

        if (response.status === 401 || response.status === 403 || response.status === 429) {
          return {
            text: null,
            metadataSources: [],
            errorDetail: lastErrorDetail
          };
        }

        if (isGeminiQuotaOrRateLimitMessage(errorDetail)) {
          return {
            text: null,
            metadataSources: [],
            errorDetail: lastErrorDetail
          };
        }

        continue;
      }

      const payload = (await response.json()) as {
        promptFeedback?: {
          blockReason?: string;
          blockReasonMessage?: string;
        };
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
          groundingMetadata?: {
            groundingChunks?: Array<{
              web?: {
                title?: string;
                uri?: string;
              };
            }>;
            groundingSupports?: Array<{
              segment?: {
                text?: string;
              };
              groundingChunkIndices?: number[];
            }>;
          };
          citationMetadata?: {
            citationSources?: Array<{
              uri?: string;
              title?: string;
            }>;
          };
        }>;
      };

      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((part) => part.text ?? "").join("\n").trim();
      const metadataSources = parseGroundingMetadataSources(payload);

      if (text || metadataSources.length) {
        clearTimeout(timeout);
        return {
          text: text || null,
          metadataSources
        };
      }

      const noCandidates = !payload.candidates?.length;
      const emptyContent = !text;
      if (noCandidates || emptyContent) {
        const pf = payload.promptFeedback;
        if (pf?.blockReason) {
          const msg = [pf.blockReason, pf.blockReasonMessage].filter(Boolean).join(": ");
          lastErrorDetail = sanitizeSnippet(msg || pf.blockReason, 240);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastErrorDetail = "Gemini grounding timed out while fetching web sources.";
      } else {
        lastErrorDetail = sanitizeSnippet(error instanceof Error ? error.message : "Gemini grounding request failed.", 240);
      }
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastErrorDetail) {
    return {
      text: null,
      metadataSources: [],
      errorDetail: lastErrorDetail
    };
  }

  return null;
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
Task: Generate 5 to 7 short web search queries designed to surface high-quality public sources and address the user focus when provided.
Output JSON: {"queries":["...","..."]}`;

  const generated = await callGeminiJson(prompt, queryPlanSchema);

  const fallback = [
    `${claimNormalized} fact check`,
    `${claimNormalized} official statement`,
    `${claimNormalized} verification`,
    `${claimNormalized} debunk`,
    `${claimNormalized} timeline`,
    focusQuestion ? `${claimNormalized} ${focusQuestion}` : ""
  ];

  const candidate = generated?.queries ?? fallback;
  const normalized = [...new Set(candidate.map((query) => sanitizeClaimText(query)).filter(Boolean))];

  return normalized.slice(0, MAX_SEARCH_QUERIES);
}

function parseGroundedSearchResults(raw: string): SearchResult[] {
  const parseGroundedSearchResultsFromText = (text: string): SearchResult[] => {
    const deduped = new Map<string, SearchResult>();
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const normalizeDetectedUrl = (value: string) => value.replace(/[)\],.;!?]+$/g, "").trim();

    const pushCandidate = (input: { url: string; titleHint?: string; snippetHint?: string }) => {
      const normalizedUrl = normalizeDetectedUrl(input.url);
      if (!normalizedUrl || deduped.has(normalizedUrl)) {
        return;
      }

      const guard = validateSourceUrl(normalizedUrl);
      if (guard.blocked) {
        return;
      }

      const fallbackName = sourceNameFromUrl(normalizedUrl);
      const title = sanitizeSnippet(input.titleHint ?? fallbackName, 140) || fallbackName;
      const snippet =
        sanitizeSnippet(input.snippetHint ?? `Grounded source captured for ${fallbackName}.`, 220) ||
        `Grounded source captured for ${fallbackName}.`;

      deduped.set(normalizedUrl, {
        title,
        url: normalizedUrl,
        snippet
      });
    };

    for (const line of lines) {
      const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
      for (const match of line.matchAll(markdownLinkRegex)) {
        pushCandidate({
          url: match[2],
          titleHint: match[1],
          snippetHint: line.replace(match[0], match[1]).trim()
        });
      }

      const urlRegex = /https?:\/\/[^\s<)\]]+/g;
      for (const match of line.matchAll(urlRegex)) {
        const rawUrl = match[0];
        const cleanedLine = line
          .replace(rawUrl, "")
          .replace(/^[-*\d.)\s:>]+/, "")
          .trim();

        pushCandidate({
          url: rawUrl,
          titleHint: cleanedLine || sourceNameFromUrl(rawUrl),
          snippetHint: cleanedLine || line
        });
      }
    }

    return Array.from(deduped.values());
  };

  const textParsed = parseGroundedSearchResultsFromText(raw);
  const payload = extractJsonPayload(raw);
  if (!payload) {
    return textParsed;
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    const validated = groundedSourcesSchema.safeParse(parsed);

    if (!validated.success) {
      return textParsed;
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

    const jsonParsed = Array.from(deduped.values());
    return jsonParsed.length ? jsonParsed : textParsed;
  } catch {
    return textParsed;
  }
}

async function fetchSearchResultsWithGeminiGrounding(
  claimNormalized: string,
  queries: string[],
  focusQuestion?: string
): Promise<{ results: SearchResult[]; detail?: string }> {
  const focusedPrompt = `Claim to verify: ${claimNormalized}
User focus question (optional): ${focusQuestion || "none"}
Candidate query hints: ${JSON.stringify(queries)}
Task: Use Google Search to find up-to-date public sources directly relevant to the claim and user focus.
Return strict JSON only with this shape:
{"sources":[{"title":"...","url":"https://...","snippet":"..."}]}
Rules:
- 8 to ${MAX_FETCHED_SOURCES} sources
- Prefer authoritative/reporting sources
- Include mixed evidence (supports/refutes/context) when available
- No private social profile links`;

  const expansionPrompt = `Claim to verify: ${claimNormalized}
User focus question (optional): ${focusQuestion || "none"}
Candidate query hints: ${JSON.stringify(queries)}
Task: Run a second broad web search pass on this room topic to maximize coverage.
Return strict JSON only with this shape:
{"sources":[{"title":"...","url":"https://...","snippet":"..."}]}
Rules:
- Prioritize additional sources not overlapping with common fact-check links when possible
- Include official statements, reporting, and technical explainers tied to the room topic
- Include mixed evidence (supports/refutes/context) when available
- No private social profile links`;

  const deduped = new Map<string, SearchResult>();
  let lastGroundingError: string | undefined;

  for (const prompt of [focusedPrompt, expansionPrompt]) {
    const grounded = await callGeminiGrounded(prompt);
    if (!grounded) {
      continue;
    }

    if (grounded.errorDetail) {
      lastGroundingError = grounded.errorDetail;
      if (isGeminiQuotaOrRateLimitMessage(grounded.errorDetail)) {
        break;
      }
    }

    for (const item of grounded.metadataSources) {
      if (!deduped.has(item.url)) {
        deduped.set(item.url, item);
      }
    }

    if (!grounded.text) {
      continue;
    }

    for (const item of parseGroundedSearchResults(grounded.text)) {
      if (!deduped.has(item.url)) {
        deduped.set(item.url, item);
      }
    }
  }

  return {
    results: Array.from(deduped.values()).slice(0, MAX_FETCHED_SOURCES),
    detail: deduped.size ? undefined : lastGroundingError
  };
}

async function fetchSearchResults(
  claimNormalized: string,
  queries: string[],
  focusQuestion?: string
): Promise<{ provider: SearchProvider; results: SearchResult[]; detail?: string }> {
  const grounded = await fetchSearchResultsWithGeminiGrounding(claimNormalized, queries, focusQuestion);
  if (grounded.results.length) {
    return {
      provider: "gemini-grounding",
      results: grounded.results
    };
  }

  return {
    provider: "none",
    results: [],
    detail: grounded.detail
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
      snippet: null,
      resolvedUrl: url
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

    const html = await response.text();
    const redirectedUrl = response.url || url;
    const resolvedUrl = isGroundingRedirectHost(redirectedUrl)
      ? extractCanonicalSourceUrlFromHtml(html, redirectedUrl)
      : redirectedUrl;

    if (isGroundingRedirectHost(resolvedUrl)) {
      return {
        blocked: null,
        snippet: null,
        resolvedUrl
      };
    }

    const resolvedGuard = validateSourceUrl(resolvedUrl);

    if (resolvedGuard.blocked) {
      return {
        blocked: resolvedGuard,
        snippet: null,
        resolvedUrl
      };
    }

    if (response.status === 402) {
      return {
        blocked: {
          blocked: true as const,
          rule: "PAYWALLED_CONTENT" as const,
          explanation: "Source requires payment and is blocked by policy."
        },
        snippet: null,
        resolvedUrl
      };
    }

    const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
    const textOnly = stripped.replace(/<[^>]+>/g, " ");
    const snippet = sanitizeSnippet(textOnly, 300);

    return {
      blocked: null,
      snippet: snippet && !isLikelyErrorSnippet(snippet) ? snippet : null,
      resolvedUrl
    };
  } catch {
    return {
      blocked: null,
      snippet: null,
      resolvedUrl: url
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

function formatRefreshNote(refreshState: "skipped" | "ran" | "cooldown" | "failed" | "quota") {
  if (refreshState === "ran") {
    return "I also refreshed the investigation before replying.";
  }

  if (refreshState === "quota") {
    return "I skipped a fresh web retrieval run because Gemini quota/rate-limit is currently reached.";
  }

  if (refreshState === "cooldown") {
    return "I used current room evidence because the refresh endpoint is cooling down.";
  }

  if (refreshState === "failed") {
    return "I could not refresh sources right now, so this is based on current room evidence.";
  }

  return null;
}

function formatGroundingStatusNote(detail: string | null | undefined) {
  if (!detail) {
    return null;
  }

  if (isGeminiQuotaOrRateLimitMessage(detail)) {
    return "Latest grounding status: Gemini API quota/rate-limit reached. Web source refresh is temporarily unavailable until quota resets.";
  }

  return `Latest grounding status: ${sanitizeSnippet(detail, 240)}`;
}

type StanceLinkRow = {
  sourceName: string;
  sourceUrl: string;
  stance: Stance;
  snippet: string;
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

function reasonForSource(row: StanceLinkRow, summariesByUrl?: Map<string, string>) {
  const mapped = summariesByUrl?.get(row.sourceUrl);
  if (mapped) {
    return sanitizeSnippet(mapped, 200);
  }

  const excerpt = sanitizeSnippet(row.snippet, 170);

  if (row.stance === Stance.SUPPORTS) {
    return excerpt || "Supports the claim according to this source text.";
  }

  if (row.stance === Stance.REFUTES) {
    return excerpt || "Refutes the claim according to this source text.";
  }

  return excerpt || "Provides context that does not fully confirm or refute the claim.";
}

function formatLinkBucket(title: string, rows: StanceLinkRow[], summariesByUrl?: Map<string, string>) {
  if (!rows.length) {
    return `${title}: none found in the latest grounded run.`;
  }

  return [
    `${title}:`,
    ...rows.map((row, index) => `${index + 1}. ${row.sourceName} - ${row.sourceUrl}\n   Reason: ${reasonForSource(row, summariesByUrl)}`)
  ].join("\n");
}

function buildStanceGroupedLinks(rows: StanceLinkRow[], summariesByUrl?: Map<string, string>) {
  const deduped = dedupeStanceLinks(rows);

  if (!deduped.length) {
    return "No eligible public sources found in the latest grounded run.";
  }

  const supports = deduped.filter((row) => row.stance === Stance.SUPPORTS);
  const refutes = deduped.filter((row) => row.stance === Stance.REFUTES);
  const context = deduped.filter((row) => row.stance === Stance.CONTEXT);

  return [
    `All source reasons (${deduped.length} total):`,
    formatLinkBucket("Supportive links", supports, summariesByUrl),
    formatLinkBucket("Refuting links", refutes, summariesByUrl),
    formatLinkBucket("Unclear/context links", context, summariesByUrl)
  ].join("\n\n");
}

function fallbackLinkUnderstandingSummary(snippet: string) {
  const compact = snippet.replace(/\s+/g, " ").trim();
  const withoutBoilerplate = compact
    .replace(/about press copyright contact us creator advertise developers.*/i, "")
    .replace(/privacy policy.*$/i, "")
    .replace(/all rights reserved.*$/i, "")
    .trim();

  return sanitizeSnippet(withoutBoilerplate || compact, 190) || "Provides context related to the claim.";
}

async function buildEvidenceLinkUnderstanding(
  claimNormalized: string,
  question: string,
  evidenceRows: Array<{ sourceName: string; sourceUrl: string; stance: Stance; snippet: string }>
) {
  if (!evidenceRows.length) {
    return new Map<string, string>();
  }

  const compactRows = evidenceRows.slice(0, 8).map((row) => ({
    sourceName: row.sourceName,
    sourceUrl: row.sourceUrl,
    stance: row.stance,
    snippet: row.snippet
  }));

  const prompt = `Claim to verify: ${claimNormalized}
User question: ${question || "Give your latest investigative take on this rumour."}
Evidence rows JSON: ${JSON.stringify(compactRows)}
Task:
1) Summarize what each source says about the claim in one concise sentence.
2) Ignore website boilerplate/navigation/cookie text.
3) Keep summaries factual and neutral.
Output JSON: {"summaries":[{"sourceUrl":"https://...","summary":"..."}]}`;

  const generated = await callGeminiJson(prompt, linkUnderstandingSchema);
  const summariesByUrl = new Map<string, string>();
  const allowedUrls = new Set(compactRows.map((row) => row.sourceUrl));

  if (generated?.summaries?.length) {
    for (const item of generated.summaries) {
      if (!allowedUrls.has(item.sourceUrl)) {
        continue;
      }

      const summary = sanitizeSnippet(item.summary, 220);
      if (!summary) {
        continue;
      }

      summariesByUrl.set(item.sourceUrl, summary);
    }
  }

  for (const row of compactRows) {
    if (!summariesByUrl.has(row.sourceUrl)) {
      summariesByUrl.set(row.sourceUrl, fallbackLinkUnderstandingSummary(row.snippet));
    }
  }

  return summariesByUrl;
}

function formatLinkUnderstandingSection(rows: StanceLinkRow[], summariesByUrl: Map<string, string>) {
  const deduped = dedupeStanceLinks(rows).slice(0, 6);

  if (!deduped.length) {
    return "Link understanding: no eligible links available yet.";
  }

  return [
    "Link understanding:",
    ...deduped.map(
      (row, index) =>
        `${index + 1}. ${row.sourceName} (${row.stance.toLowerCase()}): ${reasonForSource(row, summariesByUrl)} Source: ${row.sourceUrl}`
    )
  ].join("\n");
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
Evidence rows (JSON): ${JSON.stringify(evidenceRows.slice(0, MAX_ASSESSMENT_ROWS))}
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

  if (isArmoriqConfigured() && env.ARMORIQ_API_KEY) {
    const plan = buildVeriWireAgentPlan({
      roomId,
      claimNormalized: room.claimNormalized,
      focusQuestion: focusQuestion || undefined
    });
    const userId = actorId ?? env.ARMORIQ_USER_ID ?? `room:${roomId}`;
    const agentId = env.ARMORIQ_AGENT_ID ?? "veriwire-veriagent";
    const contextId = env.ARMORIQ_CONTEXT_ID ?? "default";
    const promptForIntent = focusQuestion
      ? `${room.claimNormalized.slice(0, 500)}\n\nFocus: ${focusQuestion}`
      : room.claimNormalized.slice(0, 800);

    try {
      const intent = await requestArmorIQIntentToken({
        apiKey: env.ARMORIQ_API_KEY,
        userId,
        agentId,
        contextId,
        plan,
        llm: getGeminiCandidateModels()[0] ?? "gemini-2.5-flash",
        prompt: promptForIntent,
        validitySeconds: 120
      });

      await appendAuditLog({
        roomId,
        actorId,
        actorType: "AGENT",
        action: "ARMORIQ_INTENT_ISSUED",
        payload: {
          intentReference: intent.intentReference,
          planHash: intent.planHash,
          merkleRoot: intent.merkleRoot,
          stepCount: intent.stepCount,
          agentId,
          contextId
        }
      });

      const refShort = intent.intentReference.length > 10 ? `${intent.intentReference.slice(0, 8)}…` : intent.intentReference;
      const hashShort = intent.planHash.length > 12 ? `${intent.planHash.slice(0, 10)}…` : intent.planHash;
      await prisma.agentEvent.create({
        data: {
          roomId,
          step: "ARMORIQ_INTENT",
          detail: `Cryptographic intent bound (${refShort}, plan ${hashShort})`,
          progress: 12
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (env.ARMORIQ_STRICT) {
        throw error;
      }
      await appendAuditLog({
        roomId,
        actorId,
        actorType: "AGENT",
        action: "ARMORIQ_INTENT_SKIPPED",
        payload: {
          reason: message.slice(0, 500)
        }
      });

      await prisma.agentEvent.create({
        data: {
          roomId,
          step: "ARMORIQ_INTENT",
          detail: `ArmorIQ unavailable (run continues): ${sanitizeSnippet(message, 180)}`,
          progress: 12
        }
      });
    }
  }

  const queries = await generateSearchQueries(room.claimNormalized, focusQuestion || undefined);

  await prisma.agentEvent.create({
    data: {
      roomId,
      step: "QUERY_GENERATION",
      detail: `Generated ${queries.length} queries`,
      progress: 20
    }
  });

  await prisma.agentEvent.create({
    data: {
      roomId,
      step: "SOURCE_FETCH",
      detail: "Starting Gemini grounding search for this run.",
      progress: 25
    }
  });

  let provider: SearchProvider = "none";
  let results: SearchResult[] = [];
  let detail: string | undefined;

  try {
    const fetched = await fetchSearchResults(
      room.claimNormalized,
      queries,
      focusQuestion || undefined
    );

    provider = fetched.provider;
    results = fetched.results;
    detail = fetched.detail;
  } catch (error) {
    detail = sanitizeSnippet(error instanceof Error ? error.message : "Failed to fetch grounded search results.", 220);

    await prisma.agentEvent.create({
      data: {
        roomId,
        step: "SOURCE_FETCH",
        detail: `Gemini grounding failed before source processing: ${detail}`,
        progress: 30
      }
    });
  }

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

  if (results.length === 0) {
    const noResultsDetail = detail
      ? summarizeGroundingFailure(detail)
      : provider === "gemini-grounding"
        ? "Gemini grounding returned no eligible public sources for generated queries."
        : "Gemini grounding is unavailable or returned no eligible public sources.";

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
    const resolvedSourceUrl = snippetResponse.resolvedUrl || result.url;
    const resolvedSourceTitle = result.title || sourceNameFromUrl(resolvedSourceUrl);

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
          sourceUrl: resolvedSourceUrl,
          explanation: snippetResponse.blocked.explanation
        }
      });

      continue;
    }

    const snippet = snippetResponse.snippet ?? result.snippet;
    if (!snippet) {
      continue;
    }

    if (
      !isLikelyRelevantSource(
        room.claimNormalized,
        {
          title: resolvedSourceTitle,
          url: resolvedSourceUrl,
          snippet
        },
        focusQuestion || undefined
      )
    ) {
      await prisma.agentEvent.create({
        data: {
          roomId,
          step: "SOURCE_FETCH",
          detail: `Skipped ${index + 1}/${results.length} off-claim source: ${sourceNameFromUrl(resolvedSourceUrl)}`,
          progress: Math.min(95, 30 + index * 10)
        }
      });

      continue;
    }

    const stanceClass = await classifyEvidenceWithGemini(
      room.claimNormalized,
      {
        title: resolvedSourceTitle,
        url: resolvedSourceUrl,
        snippet
      },
      focusQuestion || undefined
    );

    const existingAgentEvidence = await prisma.evidence.findFirst({
      where: {
        roomId,
        sourceUrl: resolvedSourceUrl,
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
            sourceName: sourceNameFromUrl(resolvedSourceUrl),
            sourceFaviconUrl: `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(resolvedSourceUrl)}`,
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
              sourceUrl: resolvedSourceUrl,
              sourceName: sourceNameFromUrl(resolvedSourceUrl),
              sourceFaviconUrl: `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(resolvedSourceUrl)}`,
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
        removedAt: null,
        sourceUrl: {
          not: {
            contains: "vertexaisearch.cloud.google.com/grounding-api-redirect"
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      },
      take: MAX_FETCHED_SOURCES,
      select: {
        sourceName: true,
        sourceUrl: true,
        snippet: true,
        stance: true
      }
    });

    assessmentRows = existingEvidence
      .filter((item) =>
        isLikelyRelevantSource(
          room.claimNormalized,
          {
            title: item.sourceName,
            url: item.sourceUrl,
            snippet: item.snippet
          },
          focusQuestion || undefined
        )
      )
      .map((item) => ({
        sourceUrl: item.sourceUrl,
        snippet: item.snippet,
        stance: item.stance
      }));
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
    const fallbackRowsForPinning = await prisma.evidence.findMany({
      where: {
        roomId,
        submittedBy: "AGENT",
        removedAt: null,
        sourceUrl: {
          not: {
            contains: "vertexaisearch.cloud.google.com/grounding-api-redirect"
          }
        }
      },
      orderBy: {
        createdAt: "desc"
      },
      take: MAX_FETCHED_SOURCES,
      select: {
        id: true,
        sourceName: true,
        sourceUrl: true,
        snippet: true,
        stance: true,
        agentConfidence: true
      }
    });

    const rowsForPinning = (savedEvidence.length > 0 ? savedEvidence : fallbackRowsForPinning).filter((item) =>
      isLikelyRelevantSource(
        room.claimNormalized,
        {
          title: item.sourceName,
          url: item.sourceUrl,
          snippet: item.snippet
        },
        focusQuestion || undefined
      )
    );

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

  let refreshState: "skipped" | "ran" | "cooldown" | "failed" | "quota" = "skipped";

  const latestSourceFetchEvent = await prisma.agentEvent.findFirst({
    where: {
      roomId,
      step: "SOURCE_FETCH"
    },
    orderBy: {
      createdAt: "desc"
    },
    select: {
      detail: true,
      createdAt: true
    }
  });

  const shouldSkipRefreshForQuota =
    !!latestSourceFetchEvent &&
    isGeminiQuotaOrRateLimitMessage(latestSourceFetchEvent.detail) &&
    Date.now() - latestSourceFetchEvent.createdAt.getTime() < GROUNDING_QUOTA_COOLDOWN_MS;

  if (shouldSkipRefreshForQuota) {
    refreshState = "quota";
  } else {
    try {
      await runAgentPipeline(roomId, actorId, {
        focusQuestion: question
      });
      refreshState = "ran";
    } catch (error) {
      refreshState = error instanceof RateLimitError ? "cooldown" : "failed";
    }
  }

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: {
      claimNormalized: true,
      agentEvents: {
        where: {
          step: "SOURCE_FETCH"
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 1,
        select: {
          detail: true
        }
      },
      evidence: {
        where: { removedAt: null },
        orderBy: { createdAt: "desc" },
        take: 50,
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

  const usableEvidence = room.evidence.filter(
    (item) =>
      !isGroundingRedirectHost(item.sourceUrl) &&
      isLikelyRelevantSource(
        room.claimNormalized,
        {
          title: item.sourceName,
          url: item.sourceUrl,
          snippet: item.snippet
        },
        question || undefined
      )
  );

  const usableRowsForAssessment = usableEvidence.map((item) => ({
    sourceUrl: item.sourceUrl,
    snippet: item.snippet,
    stance: item.stance
  }));

  const assessment = await assessEvidence(room.claimNormalized, usableRowsForAssessment);

  const rankedEvidence = [...usableEvidence].sort((a, b) => {
    const rankDiff = evidenceRankForPrompt(a.stance, promptLower) - evidenceRankForPrompt(b.stance, promptLower);

    if (rankDiff !== 0) {
      return rankDiff;
    }

    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const selectedProofs = rankedEvidence.slice(0, 4);
  const understandingRows = rankedEvidence.slice(0, 6).map((item) => ({
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    stance: item.stance,
    snippet: item.snippet
  }));
  const summariesByUrl = await buildEvidenceLinkUnderstanding(room.claimNormalized, question, understandingRows);

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

  const stanceRows = usableEvidence.map((item) => ({
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    stance: item.stance,
    snippet: item.snippet
  }));

  const linkUnderstandingSection = formatLinkUnderstandingSection(stanceRows, summariesByUrl);
  const sourceSummary = buildStanceGroupedLinks(
    usableEvidence.map((item) => ({
      sourceName: item.sourceName,
      sourceUrl: item.sourceUrl,
      stance: item.stance,
      snippet: item.snippet
    })),
    summariesByUrl
  );
  const sourceStatusNote = !usableEvidence.length ? formatGroundingStatusNote(room.agentEvents[0]?.detail ?? "") : null;

  const hasGroundingModelConfigured = getGeminiGroundingCandidateModels().length > 0;

  const providerNote = env.GEMINI_API_KEY
    ? hasGroundingModelConfigured
      ? "Web retrieval mode: Gemini grounding search only."
      : "Web retrieval mode: disabled for current model config (no grounding-capable Gemini model)."
    : "Web retrieval is unavailable because GEMINI_API_KEY is missing.";

  const refreshNote = formatRefreshNote(refreshState);
  const opinionSection = `Opinion summary: ${narrative ?? fallbackNarrative}`;
  const opinionText = [linkUnderstandingSection, opinionSection, sourceSummary, sourceStatusNote, providerNote, refreshNote]
    .filter(Boolean)
    .join("\n\n");
  const replyMaxLength = Math.min(12000, Math.max(2200, 1500 + usableEvidence.length * 220));

  const wantsExplicitProofs = /\b(proof|proofs|evidence|source|sources|cite|citations|why)\b/.test(promptLower);
  const proofNotes = wantsExplicitProofs
    ? selectedProofs.slice(0, 2).map((item, index) => ({
        evidenceId: item.id,
        body: sanitizeChatBody(
          `Proof ${index + 1}: ${item.sourceName} (${item.stance}) says ${summariesByUrl.get(item.sourceUrl) ?? sanitizeSnippet(item.snippet, 200)} Source: ${item.sourceUrl}`,
          360
        )
      }))
    : [];

  return {
    blocked: false,
    replyText: sanitizeChatBody(opinionText, replyMaxLength),
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
