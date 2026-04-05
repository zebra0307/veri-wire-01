import { RoomRole, RoomStatus, Stance } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { handleRouteError, jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { unwrapRouteParams } from "@/lib/route-params";
import { requireRoomRole } from "@/lib/security/authz";
import { validateSourceUrl } from "@/lib/security/agent-guard";
import { RateLimitError, enforceRateLimit } from "@/lib/security/rate-limit";
import { sanitizeSnippet } from "@/lib/security/sanitize";
import { publishSpacetimeEvent } from "@/lib/spacetime";
import { evidenceSchema, removeEvidenceSchema } from "@/lib/validation";

function sourceNameFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown";
  }
}

async function fetchEvidenceSnippet(url: string) {
  const guard = validateSourceUrl(url);
  if (guard.blocked) {
    return {
      blocked: guard,
      snippet: null as string | null
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
      headers: {
        "User-Agent": "VeriWire/1.0"
      }
    });

    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      blocked: null,
      snippet: sanitizeSnippet(text, 300)
    };
  } catch {
    return {
      blocked: null,
      snippet: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { roomId: string } | Promise<{ roomId: string }> }
) {
  try {
    const user = await getSessionUser();
    const { roomId } = await unwrapRouteParams(params);

    await requireRoomRole({
      roomId,
      user,
      allowed: [RoomRole.OWNER, RoomRole.CONTRIBUTOR, RoomRole.VOTER]
    });

    await enforceRateLimit({
      key: `evidence:${user.id}`,
      limit: 20,
      windowSeconds: 3600
    });

    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) {
      return jsonError(404, { error: "Room not found" });
    }

    if (room.status === RoomStatus.CLOSED) {
      return jsonError(400, { error: "Room is closed and read-only" });
    }

    const body = await request.json();
    const parsed = evidenceSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(400, { error: "Invalid evidence payload", detail: parsed.error.message });
    }

    const snippetResult = await fetchEvidenceSnippet(parsed.data.sourceUrl);
    if (snippetResult.blocked) {
      await appendAuditLog({
        roomId: roomId,
        actorId: user.id,
        actorType: "USER",
        action: "EVIDENCE_BLOCKED",
        payload: {
          rule: snippetResult.blocked.rule,
          explanation: snippetResult.blocked.explanation,
          sourceUrl: parsed.data.sourceUrl
        }
      });

      return jsonError(403, {
        error: "BLOCKED",
        detail: snippetResult.blocked.explanation,
        rule: snippetResult.blocked.rule
      });
    }

    const evidence = await prisma.evidence.create({
      data: {
        roomId: roomId,
        submittedBy: user.id,
        sourceUrl: parsed.data.sourceUrl,
        sourceName: sourceNameFromUrl(parsed.data.sourceUrl),
        sourceFaviconUrl: `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(parsed.data.sourceUrl)}`,
        snippet: parsed.data.snippet ? sanitizeSnippet(parsed.data.snippet) : snippetResult.snippet ?? "Evidence source submitted.",
        stance: parsed.data.stance as Stance,
        type: "OBSERVATION",
        agentConfidence: null,
        disputedBy: []
      }
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        evidenceSubmitted: {
          increment: 1
        },
        roomsContributed: {
          increment: 1
        }
      }
    });

    const evidenceCount = await prisma.evidence.count({
      where: {
        roomId: roomId,
        removedAt: null
      }
    });

    if (evidenceCount >= 3) {
      await prisma.checklistTask.updateMany({
        where: {
          roomId: roomId,
          title: "3 evidence items added"
        },
        data: {
          status: "DONE",
          completedAt: new Date()
        }
      });
    }

    await appendAuditLog({
      roomId: roomId,
      actorId: user.id,
      actorType: "USER",
      action: "EVIDENCE_ADDED",
      payload: {
        evidenceId: evidence.id,
        sourceUrl: evidence.sourceUrl,
        stance: evidence.stance
      }
    });

    await publishSpacetimeEvent({
      roomId: roomId,
      event: "room.evidence.created",
      data: {
        evidenceId: evidence.id,
        submittedBy: evidence.submittedBy,
        stance: evidence.stance,
        sourceName: evidence.sourceName,
        snippetPreview: evidence.snippet.slice(0, 240)
      },
      createdAt: evidence.createdAt.toISOString()
    });

    return NextResponse.json({ evidence });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return jsonError(429, { error: "Rate limit exceeded", detail: error.message });
    }

    return handleRouteError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { roomId: string } | Promise<{ roomId: string }> }
) {
  try {
    const user = await getSessionUser();
    const { roomId } = await unwrapRouteParams(params);

    await requireRoomRole({
      roomId,
      user,
      allowed: [RoomRole.OWNER]
    });

    const url = new URL(request.url);
    const evidenceId = url.searchParams.get("evidenceId");
    const parsed = removeEvidenceSchema.safeParse({ evidenceId });

    if (!parsed.success) {
      return jsonError(400, { error: "Missing evidenceId" });
    }

    const existing = await prisma.evidence.findUnique({ where: { id: parsed.data.evidenceId } });
    if (!existing || existing.roomId !== roomId) {
      return jsonError(404, { error: "Evidence not found" });
    }

    await prisma.evidence.update({
      where: { id: parsed.data.evidenceId },
      data: {
        removedAt: new Date()
      }
    });

    await appendAuditLog({
      roomId: roomId,
      actorId: user.id,
      actorType: "USER",
      action: "EVIDENCE_REMOVED",
      payload: {
        evidenceId: parsed.data.evidenceId
      }
    });

    return NextResponse.json({ removed: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
