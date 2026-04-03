import { RoomRole, RoomStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { deriveVerdictFromVotes } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireRoomRole } from "@/lib/security/authz";
import { statusSchema } from "@/lib/validation";
import { onRoomClosed } from "@/lib/workflows";

const allowedTransitions: Record<RoomStatus, RoomStatus[]> = {
  OPEN: [RoomStatus.INVESTIGATING],
  INVESTIGATING: [RoomStatus.PENDING_VERDICT],
  PENDING_VERDICT: [RoomStatus.CLOSED],
  CLOSED: []
};

export async function POST(request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    const user = await getSessionUser();

    await requireRoomRole({
      roomId: params.roomId,
      user,
      allowed: [RoomRole.OWNER]
    });

    const room = await prisma.room.findUnique({
      where: { id: params.roomId }
    });

    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    const body = await request.json();
    const parsed = statusSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(400, { error: "Invalid status payload", detail: parsed.error.message });
    }

    const nextStatus = parsed.data.status as RoomStatus;
    if (!allowedTransitions[room.status].includes(nextStatus)) {
      return jsonError(400, {
        error: "Invalid state transition",
        detail: `Cannot transition from ${room.status} to ${nextStatus}`
      });
    }

    if (nextStatus === RoomStatus.CLOSED) {
      const votes = await prisma.vote.findMany({
        where: {
          roomId: params.roomId
        },
        select: {
          verdict: true,
          weight: true
        }
      });

      if (votes.length < 3) {
        return jsonError(400, { error: "At least 3 votes are required to close a room" });
      }

      const derived = deriveVerdictFromVotes(votes);

      await prisma.room.update({
        where: { id: params.roomId },
        data: {
          status: RoomStatus.CLOSED,
          verdict: parsed.data.verdict ?? derived,
          confidence: parsed.data.confidence ?? "MEDIUM",
          closedAt: new Date()
        }
      });

      await appendAuditLog({
        roomId: params.roomId,
        actorId: user.id,
        actorType: "USER",
        action: "STATUS_TRANSITION",
        payload: {
          from: room.status,
          to: RoomStatus.CLOSED
        }
      });

      await onRoomClosed(params.roomId, user.id);

      return NextResponse.json({
        status: RoomStatus.CLOSED,
        closed: true
      });
    }

    await prisma.room.update({
      where: {
        id: params.roomId
      },
      data: {
        status: nextStatus
      }
    });

    if (nextStatus === RoomStatus.PENDING_VERDICT) {
      await prisma.checklistTask.updateMany({
        where: {
          roomId: params.roomId,
          title: "Poll opened"
        },
        data: {
          status: "DONE",
          completedAt: new Date()
        }
      });
    }

    await appendAuditLog({
      roomId: params.roomId,
      actorId: user.id,
      actorType: "USER",
      action: "STATUS_TRANSITION",
      payload: {
        from: room.status,
        to: nextStatus
      }
    });

    return NextResponse.json({ status: nextStatus });
  } catch (error) {
    return handleRouteError(error);
  }
}
