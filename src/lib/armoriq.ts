/**
 * ArmorIQ customer API client (TypeScript mirror of the Python SDK HTTP flow).
 * See: https://github.com/armoriq/armoriq-sdk-python — plan capture, /iap/sdk/token, /invoke.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

/** ArmorIQ settings read from `process.env` only — avoids importing `@/lib/env` (Zod) in Next build workers. */
function armoriqEnv() {
  return {
    ARMORIQ_ENV: process.env.ARMORIQ_ENV,
    ARMORIQ_BACKEND_URL: process.env.ARMORIQ_BACKEND_URL,
    ARMORIQ_PROXY_URL: process.env.ARMORIQ_PROXY_URL,
    ARMORIQ_API_KEY: process.env.ARMORIQ_API_KEY
  };
}

const DEFAULT_BACKEND_PROD = "https://customer-api.armoriq.ai";
const DEFAULT_PROXY_PROD = "https://customer-proxy.armoriq.ai";
const DEFAULT_BACKEND_DEV = "http://localhost:3000";
const DEFAULT_PROXY_DEV = "http://localhost:3001";

export type ArmorIQPlanStep = {
  action: string;
  mcp: string;
  params?: Record<string, unknown>;
};

export type ArmorIQPlan = {
  goal: string;
  steps: ArmorIQPlanStep[];
};

const tokenResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  token: z.any().optional(),
  plan_hash: z.string().optional(),
  merkle_root: z.string().optional(),
  intent_reference: z.string().optional(),
  composite_identity: z.string().optional(),
  plan_id: z.string().optional(),
  step_proofs: z.array(z.any()).optional(),
  client_info: z.any().optional(),
  policy_validation: z.any().optional()
});

export type ArmorIQIntentHandle = {
  intentReference: string;
  planHash: string;
  merkleRoot: string | null;
  stepCount: number;
  expiresAtMs: number;
  /** Full CSRG payload shape expected by customer proxy /invoke (matches Python `raw_token`). */
  rawToken: Record<string, unknown>;
  stepProofs: unknown[];
  policyValidation: Record<string, unknown> | null;
  raw: z.infer<typeof tokenResponseSchema>;
};

function endpoints() {
  const e = armoriqEnv();
  const dev = e.ARMORIQ_ENV === "development";
  const backend =
    e.ARMORIQ_BACKEND_URL?.trim() || (dev ? DEFAULT_BACKEND_DEV : DEFAULT_BACKEND_PROD);
  const proxy = e.ARMORIQ_PROXY_URL?.trim() || (dev ? DEFAULT_PROXY_DEV : DEFAULT_PROXY_PROD);
  return { backend, proxy };
}

export function isArmoriqConfigured(): boolean {
  const key = armoriqEnv().ARMORIQ_API_KEY?.trim();
  if (!key) return false;
  return key.startsWith("ak_live_") || key.startsWith("ak_test_");
}

function proxyUrlForMcp(mcp: string): string {
  const { proxy } = endpoints();
  const fromEnv = process.env[`${mcp.toUpperCase().replace(/-/g, "_")}_PROXY_URL`]?.trim();
  return fromEnv || proxy;
}

/**
 * Bounded VeriAgent pipeline as an ArmorIQ plan (MCP name is a logical id; align with your ArmorIQ dashboard).
 */
export function buildVeriWireAgentPlan(input: {
  roomId: string;
  claimNormalized: string;
  focusQuestion?: string;
}): ArmorIQPlan {
  const claim = input.claimNormalized.slice(0, 400);
  const goal = input.focusQuestion?.trim()
    ? `Verify claim (focused): ${claim} | Focus: ${input.focusQuestion.trim().slice(0, 200)}`
    : `Verify claim: ${claim}`;

  return {
    goal,
    steps: [
      {
        action: "generate_search_queries",
        mcp: "veriwire-agent",
        params: { room_id: input.roomId }
      },
      {
        action: "grounding_source_fetch",
        mcp: "veriwire-agent",
        params: { room_id: input.roomId }
      },
      {
        action: "classify_and_store_evidence",
        mcp: "veriwire-agent",
        params: { room_id: input.roomId }
      },
      {
        action: "assess_and_summarize",
        mcp: "veriwire-agent",
        params: { room_id: input.roomId }
      }
    ]
  };
}

/** Match Python `json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`. */
function jsonDumpsPythonCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jsonDumpsPythonCanonical(v)).join(",")}]`;
  }
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jsonDumpsPythonCanonical(o[k])}`).join(",")}}`;
}

function valueDigestForLeaf(leafValue: unknown): string {
  const valueStr = jsonDumpsPythonCanonical(leafValue);
  return createHash("sha256").update(valueStr, "utf8").digest("hex");
}

function buildRawToken(
  plan: ArmorIQPlan,
  data: z.infer<typeof tokenResponseSchema>
): Record<string, unknown> {
  const tokenData = data.token && typeof data.token === "object" ? data.token : {};
  return {
    plan,
    token: tokenData,
    plan_hash: data.plan_hash ?? "",
    merkle_root: data.merkle_root ?? "",
    intent_reference: data.intent_reference ?? "",
    composite_identity: data.composite_identity ?? ""
  };
}

export async function requestArmorIQIntentToken(input: {
  apiKey: string;
  userId: string;
  agentId: string;
  contextId: string;
  plan: ArmorIQPlan;
  llm: string;
  prompt: string;
  policy?: Record<string, unknown> | null;
  validitySeconds?: number;
}): Promise<ArmorIQIntentHandle> {
  const { backend } = endpoints();
  const expiresIn = input.validitySeconds ?? 120;

  const payload = {
    user_id: input.userId,
    agent_id: input.agentId,
    context_id: input.contextId,
    plan: input.plan,
    policy: input.policy ?? null,
    expires_in: expiresIn
  };

  const res = await fetch(`${backend.replace(/\/$/, "")}/iap/sdk/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `VeriWire/1.0 (agent=${input.agentId})`
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`ArmorIQ token response not JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`ArmorIQ token response shape unexpected: ${parsed.error.message}`);
  }

  if (!res.ok || !parsed.data.success) {
    const msg = parsed.data.message ?? text.slice(0, 300);
    throw new Error(`ArmorIQ token issuance failed (${res.status}): ${msg}`);
  }

  const intentReference = parsed.data.intent_reference ?? "";
  const planHash = parsed.data.plan_hash ?? "";

  if (!intentReference || !planHash) {
    throw new Error("ArmorIQ token response missing intent_reference or plan_hash");
  }

  const rawToken = buildRawToken(input.plan, parsed.data);
  const stepProofs = parsed.data.step_proofs ?? [];
  const policyValidation =
    parsed.data.policy_validation && typeof parsed.data.policy_validation === "object"
      ? (parsed.data.policy_validation as Record<string, unknown>)
      : null;

  return {
    intentReference,
    planHash,
    merkleRoot: parsed.data.merkle_root ?? null,
    stepCount: input.plan.steps.length,
    expiresAtMs: Date.now() + expiresIn * 1000,
    rawToken,
    stepProofs,
    policyValidation,
    raw: parsed.data
  };
}

/**
 * Invoke an MCP action through the ArmorIQ customer proxy (Python `ArmorIQClient.invoke`).
 * Requires an intent handle from {@link requestArmorIQIntentToken}; `action` must exist on the plan.
 */
export async function invokeArmorIQMcpAction(input: {
  apiKey: string;
  mcp: string;
  action: string;
  intent: ArmorIQIntentHandle;
  userId: string;
  agentId: string;
  params?: Record<string, unknown>;
  userEmail?: string;
  proxyBaseUrl?: string;
}): Promise<{ result: unknown; verified: boolean; executionSeconds: number }> {
  if (Date.now() > input.intent.expiresAtMs) {
    throw new Error("ArmorIQ intent token expired");
  }

  const proxyBase = (input.proxyBaseUrl ?? proxyUrlForMcp(input.mcp)).replace(/\/$/, "");
  const plan = input.intent.rawToken.plan as ArmorIQPlan | undefined;
  const steps = plan?.steps ?? [];
  let stepIndex: number | null = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s && typeof s === "object" && (s as ArmorIQPlanStep).action === input.action) {
      stepIndex = i;
      break;
    }
  }
  if (stepIndex === null) {
    throw new Error(
      `Action "${input.action}" not in plan: ${steps.map((s) => (s as ArmorIQPlanStep)?.action).join(", ")}`
    );
  }

  const stepObj = steps[stepIndex] as ArmorIQPlanStep | undefined;
  const leafValue = stepObj?.action ?? input.action;
  const csrgPath = `/steps/[${stepIndex}]/action`;
  const valueDigest = valueDigestForLeaf(leafValue);

  let merkleProof: unknown = input.params?.merkle_proof;
  if (merkleProof === undefined && input.intent.stepProofs.length > stepIndex) {
    merkleProof = input.intent.stepProofs[stepIndex];
  }

  const iamContext: Record<string, unknown> = {};
  if (input.intent.policyValidation?.allowed_tools) {
    iamContext.allowed_tools = input.intent.policyValidation.allowed_tools;
  }
  iamContext.user_id = input.userId;
  iamContext.agent_id = input.agentId;

  const invokeParams: Record<string, unknown> = { ...(input.params ?? {}) };
  delete invokeParams.merkle_proof;
  invokeParams._iam_context = iamContext;
  if (input.userEmail) {
    invokeParams.user_email = input.userEmail;
  }

  const innerToken = input.intent.rawToken.token;
  const payload: Record<string, unknown> = {
    mcp: input.mcp,
    action: input.action,
    tool: input.action,
    params: invokeParams,
    arguments: invokeParams,
    intent_token: input.intent.rawToken,
    merkle_proof: merkleProof,
    plan: plan ?? null,
    token: innerToken,
    csrg_token: innerToken
  };

  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Request-ID": `veriwire-${Date.now()}`,
    "X-API-Key": input.apiKey
  };

  if (merkleProof !== undefined && merkleProof !== null) {
    headers["X-CSRG-Proof"] = JSON.stringify(merkleProof);
  }
  headers["X-CSRG-Path"] = csrgPath;
  headers["X-CSRG-Value-Digest"] = valueDigest;

  const started = Date.now();
  const res = await fetch(`${proxyBase}/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000)
  });

  const buf = Buffer.from(await res.arrayBuffer());
  const responseText = buf.toString("utf8");
  const executionSeconds = (Date.now() - started) / 1000;

  if (!res.ok) {
    throw new Error(`ArmorIQ invoke failed (${res.status}): ${responseText.slice(0, 400)}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let data: Record<string, unknown> | null = null;

  if (contentType.includes("text/event-stream")) {
    for (const line of responseText.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          break;
        } catch {
          /* continue */
        }
      }
    }
    if (!data) {
      throw new Error("ArmorIQ invoke: no JSON in SSE response");
    }
  } else {
    try {
      data = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      throw new Error(`ArmorIQ invoke: invalid JSON: ${responseText.slice(0, 200)}`);
    }
  }

  if (data.error) {
    const err = data.error as { message?: string; code?: number; data?: string };
    throw new Error(
      `MCP error (${err.code ?? "?"}): ${err.message ?? "unknown"} ${err.data ?? ""}`.trim()
    );
  }

  const resultData = (data.result ?? data) as unknown;
  return {
    result: resultData,
    verified: true,
    executionSeconds
  };
}

/** Optional: proxy health check (same as Python SDK init). */
export async function checkArmorIQProxyHealth(apiKey: string): Promise<{ ok: boolean; status: number }> {
  const { proxy } = endpoints();
  try {
    const res = await fetch(`${proxy.replace(/\/$/, "")}/health`, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey
      },
      signal: AbortSignal.timeout(5000)
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Exported for unit tests: must match CSRG-IAP leaf digest expectations. */
export function armorIQCanonicalLeafDigest(leafValue: unknown): string {
  return valueDigestForLeaf(leafValue);
}
