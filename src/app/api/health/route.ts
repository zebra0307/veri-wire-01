import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    services: {
      app: "up",
      database: process.env.DATABASE_URL ? "configured" : "missing",
      redis: process.env.REDIS_URL ? "configured" : "missing",
      spacetime: "managed-cloud"
    },
    timestamp: new Date().toISOString()
  });
}
