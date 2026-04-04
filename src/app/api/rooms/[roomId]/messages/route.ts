import { RoomMessageKind, RoomRole } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { RateLimitError, enforceRateLimit } from "@/lib/security/rate-limit";
import { requireRoomRole } from "@/lib/security/authz";
import { sanitizeChatBody } from "@/lib/security/sanitize";
import { fetchRecentRoomMessagesChronological, ROOM_MESSAGE_PAGE, roomMessageInclude } from "@/lib/room-messages";
import { publishSpacetimeEvent } from "@/lib/spacetime";
import { roomMessageSchema } from "@/lib/validation";

export async function GET(_request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    await getSessionUser();

    const room = await prisma.room.findUnique({
      where: { id: params.roomId },
      select: { id: true }
    });

    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    const messages = await fetchRecentRoomMessagesChronological(params.roomId, ROOM_MESSAGE_PAGE);

    return NextResponse.json({ messages });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    const user = await getSessionUser();

    const room = await prisma.room.findUnique({
      where: { id: params.roomId },
      select: { id: true, status: true }
    });

    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    if (room.status === "CLOSED") {
      return jsonError(400, { error: "Room is closed" });
    }

    await requireRoomRole({
      roomId: params.roomId,
      user,
      allowed: [RoomRole.OWNER, RoomRole.CONTRIBUTOR, RoomRole.VOTER]
    });

    await enforceRateLimit({
      key: `room_msg:${user.id}:${params.roomId}`,
      limit: 40,
      windowSeconds: 60
    });

    const json = (await request.json()) as unknown;
    const parsed = roomMessageSchema.safeParse(json);

    if (!parsed.success) {
      return jsonError(400, {
        error: "Invalid message",
        detail: parsed.error.message
      });
    }

    const body = sanitizeChatBody(parsed.data.body);
    if (!body) {
      return jsonError(400, { error: "Message body is empty after sanitization" });
    }

    let evidenceId: string | null = null;
    if (parsed.data.evidenceId) {
      const evidence = await prisma.evidence.findFirst({
        where: {
          id: parsed.data.evidenceId,
          roomId: params.roomId,
          removedAt: null
        },
        select: { id: true }
      });

      if (!evidence) {
        return jsonError(400, { error: "Evidence not found in this room" });
      }

      evidenceId = evidence.id;
    }

    const kind =
      parsed.data.kind === "PROOF_NOTE" && evidenceId ? RoomMessageKind.PROOF_NOTE : RoomMessageKind.CHAT;

    const message = await prisma.roomMessage.create({
      data: {
        roomId: params.roomId,
        userId: user.id,
        body,
        kind,
        evidenceId
      },
      include: roomMessageInclude
    });

    await publishSpacetimeEvent({
      roomId: params.roomId,
      event: "room.message.created",
      data: {
        id: message.id,
        userId: message.userId,
        kind: message.kind,
        evidenceId: message.evidenceId,
        bodyPreview: body.slice(0, 280),
        createdAt: message.createdAt.toISOString()
      },
      createdAt: message.createdAt.toISOString()
    });

    return NextResponse.json({ message });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return jsonError(429, { error: error.message });
    }

    return handleRouteError(error);
  }
}
