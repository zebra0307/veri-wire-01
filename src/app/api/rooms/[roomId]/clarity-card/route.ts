import { RoomRole, RoomStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { generateClarityCardForRoom } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireRoomRole } from "@/lib/security/authz";

const CLARITY_TIMEOUT_MS = 30000;

class RouteTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteTimeoutError";
  }
}

async function withRouteTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new RouteTimeoutError("Clarity card generation timed out")), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function POST(_request: NextRequest, { params }: { params: { roomId: string } }) {
  try {
    const user = await getSessionUser();

    await requireRoomRole({
      roomId: params.roomId,
      user,
      allowed: [RoomRole.OWNER]
    });

    const room = await prisma.room.findUnique({ where: { id: params.roomId } });
    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    if (room.status !== RoomStatus.CLOSED) {
      return jsonError(400, { error: "Clarity card can only be generated for closed rooms" });
    }

    const generation = generateClarityCardForRoom(params.roomId);

    try {
      const card = await withRouteTimeout(generation, CLARITY_TIMEOUT_MS);

      await appendAuditLog({
        roomId: params.roomId,
        actorId: user.id,
        actorType: "USER",
        action: "CLARITY_CARD_REQUESTED",
        payload: {
          card,
          mode: "sync"
        }
      });

      return NextResponse.json({
        ok: true,
        pending: false,
        card
      });
    } catch (error) {
      if (!(error instanceof RouteTimeoutError)) {
        throw error;
      }

      generation
        .then(async (card) => {
          await appendAuditLog({
            roomId: params.roomId,
            actorId: user.id,
            actorType: "SYSTEM",
            action: "CLARITY_CARD_COMPLETED_ASYNC",
            payload: {
              card
            }
          });
        })
        .catch(async (backgroundError) => {
          await appendAuditLog({
            roomId: params.roomId,
            actorId: user.id,
            actorType: "SYSTEM",
            action: "CLARITY_CARD_ASYNC_FAILED",
            payload: {
              message: backgroundError instanceof Error ? backgroundError.message : "Unknown error"
            }
          });
        });

      await appendAuditLog({
        roomId: params.roomId,
        actorId: user.id,
        actorType: "USER",
        action: "CLARITY_CARD_REQUESTED",
        payload: {
          mode: "async",
          timeoutMs: CLARITY_TIMEOUT_MS
        }
      });

      return NextResponse.json(
        {
          ok: true,
          pending: true,
          message: "Clarity card generation is still running in background. The room will update when ready."
        },
        { status: 202 }
      );
    }
  } catch (error) {
    return handleRouteError(error);
  }
}
