import { ChecklistStatus, RoomStatus } from "@prisma/client";
import { generateClarityCardForRoom, runAgentPipeline } from "@/lib/agent";
import { appendAuditLog } from "@/lib/audit";
import { fingerprintClaim } from "@/lib/recurrence";
import { prisma } from "@/lib/prisma";

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

  // Keep this asynchronous to avoid blocking room creation responses.
  setTimeout(() => {
    runAgentPipeline(roomId, actorId).catch(async (error) => {
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
  }, 100);
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
