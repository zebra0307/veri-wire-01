import { RoomRole, RoomStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { normalizeClaim } from "@/lib/agent";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { env } from "@/lib/env";
import { handleRouteError, jsonError } from "@/lib/http";
import { maybeRecalculateHeatScores } from "@/lib/heat";
import { prisma } from "@/lib/prisma";
import { detectDuplicateOrRelatedClaim } from "@/lib/recurrence";
import { classifyToxicity, detectPii } from "@/lib/security/moderation";
import { RateLimitError, enforceRateLimit } from "@/lib/security/rate-limit";
import { sanitizeClaimText } from "@/lib/security/sanitize";
import { createRoomId } from "@/lib/utils";
import { claimSubmissionSchema } from "@/lib/validation";
import { dispatchWorkflowEvent } from "@/lib/superplane";

const allowedImageMime = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser();

    await maybeRecalculateHeatScores();

    const search = request.nextUrl.searchParams;
    const status = search.get("status") as RoomStatus | null;
    const verdict = search.get("verdict");
    const query = search.get("q")?.trim();

    const rooms = await prisma.room.findMany({
      where: {
        piiFlagged: false,
        ...(status ? { status } : {}),
        ...(verdict ? { verdict: verdict as "TRUE" | "FALSE" | "UNCLEAR" } : {}),
        ...(query
          ? {
              OR: [
                { claimNormalized: { contains: query, mode: "insensitive" } },
                { tags: { has: query.toLowerCase() } }
              ]
            }
          : {})
      },
      include: {
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
          },
          take: 5
        }
      },
      orderBy: [{ heatScore: "desc" }, { createdAt: "desc" }],
      take: 60
    });

    return NextResponse.json({
      rooms,
      demoMode: env.DEMO_BYPASS_AUTH,
      viewerRole: "CONTRIBUTOR"
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser();

    const skipClaimRateLimit =
      env.DEMO_BYPASS_AUTH &&
      typeof user.email === "string" &&
      user.email.endsWith("@veriwire.demo");

    if (!skipClaimRateLimit) {
      await enforceRateLimit({
        key: `claims:${user.id}`,
        limit: 5,
        windowSeconds: 3600
      });
    }

    const body = await request.json();
    const parsed = claimSubmissionSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(400, { error: "Invalid claim payload", detail: parsed.error.message });
    }

    const claimText = sanitizeClaimText(parsed.data.claimText);
    if (!claimText) {
      return jsonError(400, { error: "Claim text is required" });
    }

    if (parsed.data.sourceType === "IMAGE") {
      if (!parsed.data.imageMime || !allowedImageMime.has(parsed.data.imageMime)) {
        return jsonError(400, { error: "Unsupported image MIME type. SVG is blocked." });
      }

      if (!parsed.data.imageSize || parsed.data.imageSize > 5 * 1024 * 1024) {
        return jsonError(400, { error: "Image exceeds 5MB limit" });
      }
    }

    const toxicity = classifyToxicity(claimText);
    if (toxicity.isToxic) {
      return jsonError(400, { error: "Claim rejected by moderation", detail: toxicity.reason ?? undefined });
    }

    const pii = detectPii(claimText);
    const normalized = await normalizeClaim(claimText);

    if (normalized.blocked) {
      await appendAuditLog({
        actorId: user.id,
        actorType: "AGENT",
        action: "CLAIM_NORMALIZATION_BLOCKED",
        payload: {
          rule: normalized.blocked.rule,
          explanation: normalized.blocked.explanation
        }
      });

      return jsonError(403, {
        error: "BLOCKED",
        detail: normalized.blocked.explanation,
        rule: normalized.blocked.rule
      });
    }

    const recurrence = await detectDuplicateOrRelatedClaim(normalized.claimNormalized);

    if (recurrence.exact) {
      return NextResponse.json(
        {
          blocked: true,
          duplicateOf: recurrence.exact.roomId,
          score: recurrence.exact.score
        },
        { status: 409 }
      );
    }

    const room = await prisma.room.create({
      data: {
        id: createRoomId(),
        claimRaw: claimText,
        claimNormalized: normalized.claimNormalized,
        status: pii.containsPii ? RoomStatus.OPEN : RoomStatus.OPEN,
        tags: [],
        createdBy: user.id,
        piiFlagged: pii.containsPii,
        recurrenceCount: recurrence.related ? 1 : 0,
        parentRoomId: parsed.data.mergeWithRoomId ?? null
      }
    });

    await prisma.roomMember.create({
      data: {
        roomId: room.id,
        userId: user.id,
        role: RoomRole.OWNER
      }
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        roomsCreated: {
          increment: 1
        }
      }
    });

    await appendAuditLog({
      roomId: room.id,
      actorId: user.id,
      actorType: "USER",
      action: "ROOM_CREATED",
      payload: {
        claimNormalized: room.claimNormalized,
        piiFlagged: room.piiFlagged,
        relatedRoomId: recurrence.related?.roomId ?? null,
        relatedScore: recurrence.related?.score ?? null
      }
    });

    if (!pii.containsPii) {
      await dispatchWorkflowEvent({
        event: "claim.created",
        roomId: room.id,
        actorId: user.id
      });
    } else {
      await appendAuditLog({
        roomId: room.id,
        actorId: user.id,
        actorType: "SYSTEM",
        action: "ROOM_FLAGGED_FOR_MANUAL_REVIEW",
        payload: {
          piiMatches: pii.matched
        }
      });
    }

    return NextResponse.json({
      room,
      relatedWarning: recurrence.related
        ? {
            roomId: recurrence.related.roomId,
            score: recurrence.related.score
          }
        : null,
      piiReview: pii.containsPii
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return jsonError(429, { error: "Rate limit exceeded", detail: error.message });
    }

    return handleRouteError(error);
  }
}
