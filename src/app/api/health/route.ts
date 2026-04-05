import { NextResponse } from "next/server";

/** Inline proxy ping — avoids importing `@/lib/armoriq` here (reduces flaky Next “Collecting page data” / ENOENT). */
async function armoriqProxyHealth(apiKey: string): Promise<{ ok: boolean }> {
  const dev = process.env.ARMORIQ_ENV === "development";
  const proxy =
    process.env.ARMORIQ_PROXY_URL?.trim() ||
    (dev ? "http://localhost:3001" : "https://customer-proxy.armoriq.ai");
  try {
    const res = await fetch(`${proxy.replace(/\/$/, "")}/health`, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(5000)
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

function armoriqKeyLooksValid(key: string): boolean {
  return key.startsWith("ak_live_") || key.startsWith("ak_test_");
}

export async function GET() {
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const spacetimeConfigured = Boolean(process.env.SPACETIMEDB_ENDPOINT);

  let armoriq: "disabled" | "ok" | "error" | "missing_key" = "disabled";
  const aqKey = process.env.ARMORIQ_API_KEY?.trim();
  if (aqKey && armoriqKeyLooksValid(aqKey)) {
    const h = await armoriqProxyHealth(aqKey);
    armoriq = h.ok ? "ok" : "error";
  } else if (process.env.ARMORIQ_API_KEY?.trim()) {
    armoriq = "missing_key";
  }

  return NextResponse.json({
    ok: databaseConfigured && spacetimeConfigured,
    services: {
      app: "up",
      database: databaseConfigured ? "configured" : "missing",
      redis: process.env.REDIS_URL ? "configured" : "missing",
      spacetime: spacetimeConfigured ? "configured" : "missing",
      superplane: process.env.SUPERPLANE_WEBHOOK_URL ? "configured" : "local-fallback",
      armoriq
    },
    timestamp: new Date().toISOString()
  });
}
