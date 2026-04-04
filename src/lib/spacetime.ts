import { env } from "@/lib/env";

type SpacetimePayload = {
  roomId?: string;
  event: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export async function publishSpacetimeEvent(payload: SpacetimePayload) {
  if (!env.SPACETIMEDB_ENDPOINT) {
    return;
  }

  try {
    await fetch(`${env.SPACETIMEDB_ENDPOINT.replace(/\/$/, "")}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SPACETIMEDB_API_KEY ? { Authorization: `Bearer ${env.SPACETIMEDB_API_KEY}` } : {})
      },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
  } catch {
    // Keep app flow resilient if external realtime publish fails.
  }
}
