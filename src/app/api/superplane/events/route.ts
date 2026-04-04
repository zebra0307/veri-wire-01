import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { handleRouteError, jsonError } from "@/lib/http";
import { runWorkflowLocally } from "@/lib/superplane";

const eventSchema = z.object({
  event: z.enum(["claim.created", "room.closed"]),
  roomId: z.string().min(1),
  actorId: z.string().min(1)
});

export async function POST(request: NextRequest) {
  try {
    if (env.SUPERPLANE_SECRET) {
      const secret = request.headers.get("x-superplane-secret");
      if (!secret || secret !== env.SUPERPLANE_SECRET) {
        return jsonError(403, { error: "Invalid SuperPlane secret" });
      }
    }

    const body = await request.json();
    const parsed = eventSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(400, {
        error: "Invalid SuperPlane payload",
        detail: parsed.error.message
      });
    }

    await runWorkflowLocally(parsed.data);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
