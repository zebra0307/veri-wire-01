import { env } from "@/lib/env";

type SpacetimePayload = {
  roomId?: string;
  event: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export async function publishSpacetimeEvent(payload: SpacetimePayload) {
  const endpoint = env.SPACETIMEDB_ENDPOINT.replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${endpoint}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.SPACETIMEDB_API_KEY ? { Authorization: `Bearer ${env.SPACETIMEDB_API_KEY}` } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store"
    });

    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(
        detail
          ? `Spacetime publish failed (${response.status}): ${detail.slice(0, 240)}`
          : `Spacetime publish failed with status ${response.status}`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Spacetime publish timed out");
    }

    throw error instanceof Error ? error : new Error("Spacetime publish failed");
  } finally {
    clearTimeout(timeout);
  }
}
