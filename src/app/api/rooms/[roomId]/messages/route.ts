import { GlobalRole, RoomMessageKind, RoomRole } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { generateAgentChatResponse } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { unwrapRouteParams } from "@/lib/route-params";
import { RateLimitError, enforceRateLimit } from "@/lib/security/rate-limit";
import { requireRoomRole } from "@/lib/security/authz";
import { sanitizeChatBody } from "@/lib/security/sanitize";
import { fetchRecentRoomMessagesChronological, ROOM_MESSAGE_PAGE, roomMessageInclude } from "@/lib/room-messages";
import { publishSpacetimeEvent } from "@/lib/spacetime";
import { roomMessageSchema } from "@/lib/validation";

export async function GET(
  _request: NextRequest,
  { params }: { params: { roomId: string } | Promise<{ roomId: string }> }
) {
  try {
    await getSessionUser();
    const { roomId } = await unwrapRouteParams(params);

    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true }
    });

    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    const messages = await fetchRecentRoomMessagesChronological(roomId, ROOM_MESSAGE_PAGE);

    return NextResponse.json({ messages });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { roomId: string } | Promise<{ roomId: string }> }
) {
  try {
    const user = await getSessionUser();
    const { roomId } = await unwrapRouteParams(params);

    const room = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true, status: true }
    });

    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    if (room.status === "CLOSED") {
      return jsonError(400, { error: "Room is closed" });
    }

    await requireRoomRole({
      roomId: roomId,
      user,
      allowed: [RoomRole.OWNER, RoomRole.CONTRIBUTOR, RoomRole.VOTER]
    });

    await enforceRateLimit({
      key: `room_msg:${user.id}:${roomId}`,
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
          roomId: roomId,
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
        roomId: roomId,
        userId: user.id,
        body,
        kind,
        evidenceId
      },
      include: roomMessageInclude
    });

    await publishSpacetimeEvent({
      roomId: roomId,
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

    const shouldInvokeAgent =
      kind === RoomMessageKind.CHAT && /(^|\s)@agent\b|(^|\s)\/agent\b/i.test(body);

    const agentPrompt = body.replace(/(^|\s)@agent\b/gi, " ").replace(/(^|\s)\/agent\b/gi, " ").trim();

    let agentReply: Awaited<ReturnType<typeof prisma.roomMessage.create>> | null = null;
    const agentProofReplies: Array<Awaited<ReturnType<typeof prisma.roomMessage.create>>> = [];

    if (shouldInvokeAgent) {
      const agentUser = await prisma.user.upsert({
        where: { email: "agent@veriwire.system" },
        update: {
          name: "VeriAgent",
          role: GlobalRole.MODERATOR,
          contributorScore: 2.0
        },
        create: {
          email: "agent@veriwire.system",
          name: "VeriAgent",
          role: GlobalRole.MODERATOR,
          contributorScore: 2.0
        }
      });

      let agentText: string;
      let proofNotes: Array<{ evidenceId: string; body: string }> = [];

      try {
        const result = await generateAgentChatResponse(roomId, agentPrompt, user.id);
        agentText = result.replyText;
        proofNotes = result.proofNotes;
      } catch (agentError) {
        if (agentError instanceof RateLimitError) {
          agentText = "Agent is cooling down for this room. Please try again in a few minutes.";
        } else {
          agentText = "I could not complete that agent request right now. Try again shortly.";
        }
      }

      agentReply = await prisma.roomMessage.create({
        data: {
          roomId: roomId,
          userId: agentUser.id,
          body: sanitizeChatBody(agentText),
          kind: RoomMessageKind.CHAT
        },
        include: roomMessageInclude
      });

      await publishSpacetimeEvent({
        roomId: roomId,
        event: "room.message.created",
        data: {
          id: agentReply.id,
          userId: agentReply.userId,
          kind: agentReply.kind,
          evidenceId: agentReply.evidenceId,
          bodyPreview: agentReply.body.slice(0, 280),
          createdAt: agentReply.createdAt.toISOString()
        },
        createdAt: agentReply.createdAt.toISOString()
      });

      for (const note of proofNotes) {
        const proofReply = await prisma.roomMessage.create({
          data: {
            roomId: roomId,
            userId: agentUser.id,
            body: note.body,
            kind: RoomMessageKind.PROOF_NOTE,
            evidenceId: note.evidenceId
          },
          include: roomMessageInclude
        });

        agentProofReplies.push(proofReply);

        await publishSpacetimeEvent({
          roomId: roomId,
          event: "room.message.created",
          data: {
            id: proofReply.id,
            userId: proofReply.userId,
            kind: proofReply.kind,
            evidenceId: proofReply.evidenceId,
            bodyPreview: proofReply.body.slice(0, 280),
            createdAt: proofReply.createdAt.toISOString()
          },
          createdAt: proofReply.createdAt.toISOString()
        });
      }
    }

    return NextResponse.json({ message, agentReply, agentProofReplies });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return jsonError(429, { error: error.message });
    }

    return handleRouteError(error);
  }
}
