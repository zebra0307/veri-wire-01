import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    services: {
      app: "up",
      database: process.env.DATABASE_URL ? "configured" : "missing",
      redis: process.env.REDIS_URL ? "configured" : "missing",
      spacetime: process.env.SPACETIMEDB_ENDPOINT ? "configured" : "not-configured",
      superplane: process.env.SUPERPLANE_WEBHOOK_URL ? "configured" : "local-fallback"
    },
    timestamp: new Date().toISOString()
  });
}
