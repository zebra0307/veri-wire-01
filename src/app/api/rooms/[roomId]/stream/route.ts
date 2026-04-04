import { NextRequest } from "next/server";
import { computeWeightedResults } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { fetchRecentRoomMessagesChronological, ROOM_MESSAGE_SNAPSHOT_LIMIT } from "@/lib/room-messages";

export const dynamic = "force-dynamic";

type Marker = {
  room: {
    id: string;
    status: "OPEN" | "INVESTIGATING" | "PENDING_VERDICT" | "CLOSED";
    verdict: "TRUE" | "FALSE" | "UNCLEAR" | null;
    confidence: "LOW" | "MEDIUM" | "HIGH" | null;
    recurrenceCount: number;
    heatScore: number;
    closedAt: Date | null;
  } | null;
  latestEvidenceAt: string | null;
  latestVoteAt: string | null;
  latestAgentEventAt: string | null;
  latestAuditAt: string | null;
  latestMessageAt: string | null;
  latestAgentStep: string | null;
  latestAuditAction: string | null;
};

type Snapshot = {
  room: unknown;
  roomSummary: unknown;
  weighted: ReturnType<typeof computeWeightedResults>;
  recurrenceBanner: {
    originalRoomId: string;
    daysAgo: number;
    resurfacedCount: number;
    originalVerdict: string | null;
  } | null;
};

async function buildRoomMarker(roomId: string) {
  const [room, latestEvidence, latestVote, latestAgentEvent, latestAudit, latestMessage] = await Promise.all([
    prisma.room.findUnique({
      where: { id: roomId },
      select: {
        id: true,
        status: true,
        verdict: true,
        confidence: true,
        recurrenceCount: true,
        heatScore: true,
        closedAt: true
      }
    }),
    prisma.evidence.findFirst({
      where: { roomId, removedAt: null },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.vote.findFirst({
      where: { roomId },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.agentEvent.findFirst({
      where: { roomId },
      select: { createdAt: true, progress: true, blocked: true, step: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.auditLog.findFirst({
      where: { roomId },
      select: { createdAt: true, action: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.roomMessage.findFirst({
      where: { roomId },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" }
    })
  ]);

  return {
    room,
    latestEvidenceAt: latestEvidence?.createdAt?.toISOString() ?? null,
    latestVoteAt: latestVote?.createdAt?.toISOString() ?? null,
    latestAgentEventAt: latestAgentEvent?.createdAt?.toISOString() ?? null,
    latestAuditAt: latestAudit?.createdAt?.toISOString() ?? null,
    latestMessageAt: latestMessage?.createdAt?.toISOString() ?? null,
    latestAgentStep: latestAgentEvent?.step ?? null,
    latestAuditAction: latestAudit?.action ?? null
  } satisfies Marker;
}

async function buildRoomSnapshot(roomId: string): Promise<Snapshot | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      evidence: {
        where: { removedAt: null },
        orderBy: { createdAt: "asc" }
      },
      votes: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              contributorScore: true,
              image: true
            }
          }
        }
      },
      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              image: true,
              contributorScore: true
            }
          }
        }
      },
      agentEvents: {
        orderBy: { createdAt: "asc" }
      },
      clarityCard: true,
      checklistTasks: {
        orderBy: { createdAt: "asc" }
      }
    }
  });

  if (!room) {
    return null;
  }

  const recurrenceRecord = await prisma.recurrenceRecord.findFirst({
    where: {
      roomIds: {
        has: room.id
      }
    }
  });

  let recurrenceBanner: {
    originalRoomId: string;
    daysAgo: number;
    resurfacedCount: number;
    originalVerdict: string | null;
  } | null = null;

  if (recurrenceRecord && recurrenceRecord.recurrenceCount > 1) {
    const originalRoomId = recurrenceRecord.roomIds[0];
    const originalRoom = await prisma.room.findUnique({
      where: {
        id: originalRoomId
      },
      select: {
        verdict: true,
        closedAt: true,
        createdAt: true
      }
    });

    const baselineDate = originalRoom?.closedAt ?? originalRoom?.createdAt ?? recurrenceRecord.firstSeen;
    const daysAgo = Math.max(0, Math.floor((Date.now() - baselineDate.getTime()) / (1000 * 60 * 60 * 24)));

    recurrenceBanner = {
      originalRoomId,
      daysAgo,
      resurfacedCount: recurrenceRecord.recurrenceCount,
      originalVerdict: originalRoom?.verdict ?? null
    };
  }

  const weighted = computeWeightedResults(
    room.votes.map((vote) => ({
      verdict: vote.verdict,
      weight: vote.weight
    }))
  );

  const messages = await fetchRecentRoomMessagesChronological(roomId, ROOM_MESSAGE_SNAPSHOT_LIMIT);

  const roomSummary = {
    id: room.id,
    claimRaw: room.claimRaw,
    claimNormalized: room.claimNormalized,
    status: room.status,
    verdict: room.verdict,
    confidence: room.confidence,
    heatScore: room.heatScore,
    recurrenceCount: room.recurrenceCount,
    createdAt: room.createdAt,
    closedAt: room.closedAt,
    clarityCardUrl: room.clarityCardUrl,
    voiceBriefUrl: room.voiceBriefUrl,
    piiFlagged: room.piiFlagged,
    members: room.members
  };

  return {
    room: { ...room, messages },
    roomSummary,
    weighted,
    recurrenceBanner
  };
}

export async function GET(request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    await getSessionUser();

    const encoder = new TextEncoder();
    const roomId = params.roomId;
    const resumeFrom = request.headers.get("last-event-id");

    let closed = false;
    let lastMarker = "";
    let eventId = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          eventId += 1;
          controller.enqueue(encoder.encode(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const checkAndEmit = async () => {
          if (closed) {
            return;
          }

          const marker = await buildRoomMarker(roomId);
          const serialized = JSON.stringify(marker);

          if (serialized !== lastMarker) {
            const isInitialSync = lastMarker.length === 0;
            lastMarker = serialized;
            const snapshot = await buildRoomSnapshot(roomId);

            send("room.patch", {
              roomId,
              marker,
              snapshot,
              reason: isInitialSync ? "initial-sync" : "delta",
              timestamp: new Date().toISOString()
            });
          }
        };

        send("stream.ready", {
          roomId,
          timestamp: new Date().toISOString(),
          heartbeatEveryMs: 15000,
          pollEveryMs: 2500,
          resumeFrom: resumeFrom ?? null
        });
        await checkAndEmit();

        interval = setInterval(() => {
          checkAndEmit().catch(() => {
            if (!closed) {
              send("stream.error", {
                roomId,
                timestamp: new Date().toISOString(),
                fallback: "polling"
              });
            }
          });
        }, 2500);

        heartbeat = setInterval(() => {
          send("stream.heartbeat", { roomId, timestamp: new Date().toISOString() });
        }, 15000);

        request.signal.addEventListener("abort", () => {
          closed = true;
          if (interval) clearInterval(interval);
          if (heartbeat) clearInterval(heartbeat);
          controller.close();
        });
      },
      cancel() {
        closed = true;
        if (interval) clearInterval(interval);
        if (heartbeat) clearInterval(heartbeat);
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      }
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
