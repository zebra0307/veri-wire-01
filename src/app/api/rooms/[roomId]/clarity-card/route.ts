import { RoomRole, RoomStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { generateClarityCardForRoom } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireRoomRole } from "@/lib/security/authz";

export async function POST(_request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    const user = await getSessionUser();

    await requireRoomRole({
      roomId: params.roomId,
      user,
      allowed: [RoomRole.OWNER]
    });

    const room = await prisma.room.findUnique({ where: { id: params.roomId } });
    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    if (room.status !== RoomStatus.CLOSED) {
      return jsonError(400, { error: "Clarity card can only be generated for closed rooms" });
    }

    const card = await generateClarityCardForRoom(params.roomId);

    await appendAuditLog({
      roomId: params.roomId,
      actorId: user.id,
      actorType: "USER",
      action: "CLARITY_CARD_REQUESTED",
      payload: {
        card
      }
    });

    return NextResponse.json({
      ok: true,
      card
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
