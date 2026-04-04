import { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function buildRoomMarker(roomId: string) {
  const [room, latestEvidence, latestVote, latestAgentEvent, latestAudit] = await Promise.all([
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
    })
  ]);

  return {
    room,
    latestEvidenceAt: latestEvidence?.createdAt?.toISOString() ?? null,
    latestVoteAt: latestVote?.createdAt?.toISOString() ?? null,
    latestAgentEventAt: latestAgentEvent?.createdAt?.toISOString() ?? null,
    latestAuditAt: latestAudit?.createdAt?.toISOString() ?? null,
    latestAgentStep: latestAgentEvent?.step ?? null,
    latestAuditAction: latestAudit?.action ?? null
  };
}

export async function GET(request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    await getSessionUser();

    const encoder = new TextEncoder();
    const roomId = params.roomId;

    let closed = false;
    let lastMarker = "";
    let interval: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        const checkAndEmit = async () => {
          if (closed) {
            return;
          }

          const marker = await buildRoomMarker(roomId);
          const serialized = JSON.stringify(marker);

          if (serialized !== lastMarker) {
            lastMarker = serialized;
            send("room.update", {
              roomId,
              marker,
              timestamp: new Date().toISOString()
            });
          }
        };

        send("stream.ready", { roomId, timestamp: new Date().toISOString() });
        await checkAndEmit();

        interval = setInterval(() => {
          checkAndEmit().catch(() => {
            if (!closed) {
              send("stream.error", { roomId });
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
        Connection: "keep-alive"
      }
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
