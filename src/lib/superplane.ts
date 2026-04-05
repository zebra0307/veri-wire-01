import { env } from "@/lib/env";
import { appendAuditLog } from "@/lib/audit";
import { onClaimCreated, onRoomClosed } from "@/lib/workflows";

export type SuperPlaneEvent = "claim.created" | "room.closed";

export async function runWorkflowLocally(input: {
  event: SuperPlaneEvent;
  roomId: string;
  actorId: string;
}) {
  if (input.event === "claim.created") {
    await onClaimCreated(input.roomId, input.actorId);
    return;
  }

  await onRoomClosed(input.roomId, input.actorId);
}

export async function dispatchWorkflowEvent(input: {
  event: SuperPlaneEvent;
  roomId: string;
  actorId: string;
}) {
  if (env.SUPERPLANE_WEBHOOK_URL) {
    try {
      const response = await fetch(env.SUPERPLANE_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.SUPERPLANE_SECRET ? { "x-superplane-secret": env.SUPERPLANE_SECRET } : {})
        },
        body: JSON.stringify(input),
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`SuperPlane webhook returned status ${response.status}`);
      }

      await appendAuditLog({
        roomId: input.roomId,
        actorId: input.actorId,
        actorType: "SYSTEM",
        action: "SUPERPLANE_EVENT_DISPATCHED",
        payload: {
          event: input.event,
          mode: "remote"
        }
      });

      return;
    } catch {
      await appendAuditLog({
        roomId: input.roomId,
        actorId: input.actorId,
        actorType: "SYSTEM",
        action: "SUPERPLANE_DISPATCH_FAILED_FALLBACK",
        payload: {
          event: input.event,
          mode: "local"
        }
      });
    }
  }

  await runWorkflowLocally(input);
}
