import { RoomRole, RoomStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { computeWeightedResults } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireRoomRole } from "@/lib/security/authz";
import { RateLimitError, enforceRateLimit } from "@/lib/security/rate-limit";
import { voteSchema } from "@/lib/validation";

export async function POST(request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    const user = await getSessionUser();

    await requireRoomRole({
      roomId: params.roomId,
      user,
      allowed: [RoomRole.OWNER, RoomRole.CONTRIBUTOR, RoomRole.VOTER]
    });

    const room = await prisma.room.findUnique({ where: { id: params.roomId } });
    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    if (room.status !== RoomStatus.PENDING_VERDICT) {
      return jsonError(400, { error: "Voting is only available in PENDING_VERDICT state" });
    }

    const body = await request.json();
    const parsed = voteSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(400, { error: "Invalid vote payload", detail: parsed.error.message });
    }

    const existing = await prisma.vote.findUnique({
      where: {
        roomId_userId: {
          roomId: params.roomId,
          userId: user.id
        }
      }
    });

    if (existing) {
      return jsonError(409, { error: "Vote already submitted and cannot be changed" });
    }

    await enforceRateLimit({
      key: `vote-submit:${params.roomId}:${user.id}`,
      limit: 5,
      windowSeconds: 60
    });

    const voter = await prisma.user.findUnique({ where: { id: user.id } });
    const weight = voter?.contributorScore ?? 1;

    const vote = await prisma.vote.create({
      data: {
        roomId: params.roomId,
        userId: user.id,
        verdict: parsed.data.verdict,
        weight
      }
    });

    const allVotes = await prisma.vote.findMany({
      where: {
        roomId: params.roomId
      },
      select: {
        verdict: true,
        weight: true
      }
    });

    const weighted = computeWeightedResults(allVotes);

    await appendAuditLog({
      roomId: params.roomId,
      actorId: user.id,
      actorType: "USER",
      action: "VOTE_CAST",
      payload: {
        voteId: vote.id,
        verdict: vote.verdict,
        weight: vote.weight
      }
    });

    return NextResponse.json({ vote, weighted, voteCount: allVotes.length });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return jsonError(429, { error: "Rate limit exceeded", detail: error.message });
    }

    return handleRouteError(error);
  }
}
