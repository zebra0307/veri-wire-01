import { RoomStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

let lastHeatRecalcAt = 0;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function computeHeatScore(input: {
  status: RoomStatus;
  createdAt: Date;
  evidenceCount: number;
  voteCount: number;
  recentAuditCount: number;
}) {
  const ageHours = Math.max(1, (Date.now() - input.createdAt.getTime()) / (1000 * 60 * 60));
  const statusBoost =
    input.status === RoomStatus.INVESTIGATING
      ? 0.26
      : input.status === RoomStatus.PENDING_VERDICT
        ? 0.2
        : input.status === RoomStatus.OPEN
          ? 0.12
          : 0.02;

  const activityRaw = input.evidenceCount * 0.08 + input.voteCount * 0.09 + input.recentAuditCount * 0.05;
  const decay = 1 / Math.sqrt(ageHours);

  return clamp(statusBoost + activityRaw * decay, 0, 1);
}

export async function recalculateHeatScores() {
  const rooms = await prisma.room.findMany({
    where: {
      status: {
        in: [RoomStatus.OPEN, RoomStatus.INVESTIGATING, RoomStatus.PENDING_VERDICT, RoomStatus.CLOSED]
      }
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      _count: {
        select: {
          evidence: true,
          votes: true
        }
      }
    }
  });

  const now = Date.now();
  let updated = 0;

  for (const room of rooms) {
    const recentAuditCount = await prisma.auditLog.count({
      where: {
        roomId: room.id,
        createdAt: {
          gte: new Date(now - 1000 * 60 * 60)
        }
      }
    });

    const heatScore = computeHeatScore({
      status: room.status,
      createdAt: room.createdAt,
      evidenceCount: room._count.evidence,
      voteCount: room._count.votes,
      recentAuditCount
    });

    await prisma.room.update({
      where: {
        id: room.id
      },
      data: {
        heatScore
      }
    });

    updated += 1;
  }

  lastHeatRecalcAt = Date.now();

  return {
    updated,
    at: new Date(lastHeatRecalcAt).toISOString()
  };
}

export async function maybeRecalculateHeatScores() {
  const now = Date.now();

  if (now - lastHeatRecalcAt < 1000 * 60 * 5) {
    return null;
  }

  return recalculateHeatScores();
}
