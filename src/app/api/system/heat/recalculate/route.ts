import { NextRequest, NextResponse } from "next/server";
import { appendAuditLog } from "@/lib/audit";
import { env } from "@/lib/env";
import { recalculateHeatScores } from "@/lib/heat";
import { handleRouteError, jsonError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const internalToken = request.headers.get("x-internal-secret");

    if (!env.INTERNAL_AGENT_SECRET || internalToken !== env.INTERNAL_AGENT_SECRET) {
      return jsonError(403, { error: "Forbidden" });
    }

    const result = await recalculateHeatScores();

    await appendAuditLog({
      actorType: "SYSTEM",
      action: "HEAT_SCORE_RECALCULATED",
      payload: result
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return handleRouteError(error);
  }
}
