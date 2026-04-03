import { NextRequest, NextResponse } from "next/server";
import { runAgentPipeline } from "@/lib/agent";
import { appendAuditLog } from "@/lib/audit";
import { env } from "@/lib/env";
import { handleRouteError, jsonError } from "@/lib/http";

export async function POST(request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    const internalToken = request.headers.get("x-agent-internal-secret");

    if (!internalToken || !env.INTERNAL_AGENT_SECRET || internalToken !== env.INTERNAL_AGENT_SECRET) {
      await appendAuditLog({
        roomId: params.roomId,
        actorType: "SYSTEM",
        action: "AGENT_RUN_REJECTED",
        payload: {
          reason: "Missing or invalid internal secret"
        }
      });

      return jsonError(403, {
        error: "Agent runs are server-side only"
      });
    }

    const result = await runAgentPipeline(params.roomId);

    return NextResponse.json({
      ok: true,
      result
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
