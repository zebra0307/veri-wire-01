import { NextRequest, NextResponse } from "next/server";
import { computeWeightedResults } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { unwrapRouteParams } from "@/lib/route-params";
import { fetchRecentRoomMessagesChronological, ROOM_MESSAGE_SNAPSHOT_LIMIT } from "@/lib/room-messages";

export async function GET(
  _request: NextRequest,
  { params }: { params: { roomId: string } | Promise<{ roomId: string }> }
) {
  try {
    await getSessionUser();
    const { roomId } = await unwrapRouteParams(params);

    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        evidence: {
          where: {
            removedAt: null
          },
          orderBy: {
            createdAt: "asc"
          }
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
          orderBy: {
            createdAt: "asc"
          }
        },
        clarityCard: true,
        checklistTasks: {
          orderBy: {
            createdAt: "asc"
          }
        }
      }
    });

    if (!room) {
      return NextResponse.json({ error: "Room not found" }, { status: 404 });
    }

    const weighted = computeWeightedResults(
      room.votes.map((vote) => ({
        verdict: vote.verdict,
        weight: vote.weight
      }))
    );

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

    const messages = await fetchRecentRoomMessagesChronological(roomId, ROOM_MESSAGE_SNAPSHOT_LIMIT);

    return NextResponse.json({
      room: { ...room, messages },
      weighted,
      recurrenceBanner
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
