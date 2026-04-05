import { ChecklistStatus, RoomStatus, Stance, Verdict } from "@prisma/client";
import { generateClarityCardForRoom, runAgentPipeline } from "@/lib/agent";
import { appendAuditLog } from "@/lib/audit";
import { fingerprintClaim } from "@/lib/recurrence";
import { prisma } from "@/lib/prisma";

function winningStance(verdict: Verdict | null) {
  if (verdict === Verdict.TRUE) {
    return Stance.SUPPORTS;
  }

  if (verdict === Verdict.FALSE) {
    return Stance.REFUTES;
  }

  return Stance.CONTEXT;
}

async function updateContributorScores(roomId: string, finalVerdict: Verdict | null) {
  if (!finalVerdict) {
    return;
  }

  const matchStance = winningStance(finalVerdict);

  const [evidenceRows, votes] = await Promise.all([
    prisma.evidence.findMany({
      where: {
        roomId,
        removedAt: null,
        submittedBy: {
          not: "AGENT"
        }
      },
      select: {
        submittedBy: true,
        stance: true
      }
    }),
    prisma.vote.findMany({
      where: {
        roomId
      },
      select: {
        userId: true,
        verdict: true
      }
    })
  ]);

  const evidenceByUser = new Map<string, { matched: number; total: number }>();

  for (const row of evidenceRows) {
    const entry = evidenceByUser.get(row.submittedBy) ?? { matched: 0, total: 0 };
    entry.total += 1;
    if (row.stance === matchStance) {
      entry.matched += 1;
    }
    evidenceByUser.set(row.submittedBy, entry);
  }

  const voteByUser = new Map<string, boolean>();
  for (const vote of votes) {
    voteByUser.set(vote.userId, vote.verdict === finalVerdict);
  }

  const userIds = new Set<string>([...evidenceByUser.keys(), ...voteByUser.keys()]);

  for (const userId of userIds) {
    const evidenceStats = evidenceByUser.get(userId);
    const voteCorrect = voteByUser.get(userId);

    let delta = 0;
    if (evidenceStats && evidenceStats.total > 0) {
      const ratio = evidenceStats.matched / evidenceStats.total;
      delta += ratio >= 0.5 ? 0.08 : -0.04;
    }

    if (typeof voteCorrect === "boolean") {
      delta += voteCorrect ? 0.03 : -0.03;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        contributorScore: {
          increment: delta
        }
      }
    });
  }
}

export async function onClaimCreated(roomId: string, actorId: string) {
  const defaultTasks = ["Agent run complete", "3 evidence items added", "Poll opened", "Verdict reached"];

  for (const title of defaultTasks) {
    await prisma.checklistTask.create({
      data: {
        roomId,
        title,
        status: ChecklistStatus.PENDING
      }
    });
  }

  await prisma.room.update({
    where: { id: roomId },
    data: {
      status: RoomStatus.INVESTIGATING
    }
  });

  await appendAuditLog({
    roomId,
    actorId,
    actorType: "SYSTEM",
    action: "WORKFLOW_CLAIM_CREATED_TRIGGERED",
    payload: {
      status: RoomStatus.INVESTIGATING,
      tasks: defaultTasks
    }
  });

  // Start immediately so room-created runs are not lost in runtimes that may drop delayed timers.
  void runAgentPipeline(roomId, actorId, { pinTopProofs: true }).catch(async (error) => {
    await appendAuditLog({
      roomId,
      actorId,
      actorType: "SYSTEM",
      action: "AGENT_RUN_FAILED",
      payload: {
        message: error instanceof Error ? error.message : "Unknown error"
      }
    });
  });
}

export async function onRoomClosed(roomId: string, actorId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });

  if (!room) {
    throw new Error("Room not found");
  }

  await prisma.room.update({
    where: { id: roomId },
    data: {
      status: RoomStatus.CLOSED,
      closedAt: room.closedAt ?? new Date()
    }
  });

  await generateClarityCardForRoom(roomId);

  const fingerprint = fingerprintClaim(room.claimNormalized);
  const existing = await prisma.recurrenceRecord.findUnique({
    where: { claimFingerprint: fingerprint }
  });

  if (!existing) {
    await prisma.recurrenceRecord.create({
      data: {
        claimFingerprint: fingerprint,
        roomIds: [roomId],
        firstSeen: room.createdAt,
        lastSeen: new Date(),
        recurrenceCount: 1
      }
    });
  } else {
    const newRoomIds = existing.roomIds.includes(roomId) ? existing.roomIds : [...existing.roomIds, roomId];

    await prisma.recurrenceRecord.update({
      where: { claimFingerprint: fingerprint },
      data: {
        roomIds: newRoomIds,
        recurrenceCount: newRoomIds.length,
        lastSeen: new Date()
      }
    });

    await prisma.room.update({
      where: { id: roomId },
      data: {
        recurrenceCount: newRoomIds.length
      }
    });
  }

  await prisma.publishedQueue.upsert({
    where: { roomId },
    update: {},
    create: { roomId }
  });

  await prisma.checklistTask.updateMany({
    where: {
      roomId,
      title: "Verdict reached"
    },
    data: {
      status: ChecklistStatus.DONE,
      completedAt: new Date()
    }
  });

  await updateContributorScores(roomId, room.verdict);

  await appendAuditLog({
    roomId,
    actorId,
    actorType: "SYSTEM",
    action: "WORKFLOW_ROOM_CLOSED_TRIGGERED",
    payload: {
      roomId,
      published: true
    }
  });
}
