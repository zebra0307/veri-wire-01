import { RoomRole } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { unwrapRouteParams } from "@/lib/route-params";
import { requireRoomRole } from "@/lib/security/authz";

export async function POST(
  _request: NextRequest,
  {
    params
  }: {
    params: { roomId: string; evidenceId: string } | Promise<{ roomId: string; evidenceId: string }>;
  }
) {
  try {
    const user = await getSessionUser();
    const { roomId, evidenceId } = await unwrapRouteParams(params);

    await requireRoomRole({
      roomId,
      user,
      allowed: [RoomRole.OWNER, RoomRole.CONTRIBUTOR, RoomRole.VOTER]
    });

    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId }
    });

    if (!evidence || evidence.roomId !== roomId || evidence.removedAt) {
      return jsonError(404, { error: "Evidence not found" });
    }

    if (evidence.submittedBy !== "AGENT") {
      return jsonError(400, { error: "Only agent evidence can be disputed" });
    }

    if (evidence.disputedBy.includes(user.id)) {
      return NextResponse.json({
        disputed: true,
        count: evidence.disputedBy.length,
        thresholdReached: evidence.disputedBy.length >= 2
      });
    }

    const updated = await prisma.evidence.update({
      where: { id: evidence.id },
      data: {
        disputedBy: [...evidence.disputedBy, user.id]
      }
    });

    await appendAuditLog({
      roomId,
      actorId: user.id,
      actorType: "USER",
      action: "EVIDENCE_DISPUTED",
      payload: {
        evidenceId: evidence.id,
        disputedCount: updated.disputedBy.length
      }
    });

    return NextResponse.json({
      disputed: true,
      count: updated.disputedBy.length,
      thresholdReached: updated.disputedBy.length >= 2
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
