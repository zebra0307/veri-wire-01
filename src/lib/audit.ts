import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { publishSpacetimeEvent } from "@/lib/spacetime";

export async function appendAuditLog(input: {
  roomId?: string;
  actorId?: string;
  actorType: "USER" | "AGENT" | "SYSTEM";
  action: string;
  payload: Prisma.InputJsonValue;
}) {
  const created = await prisma.auditLog.create({
    data: {
      roomId: input.roomId,
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      payload: input.payload
    }
  });

  await publishSpacetimeEvent({
    roomId: input.roomId,
    event: "audit.appended",
    data: {
      id: created.id,
      action: created.action,
      actorType: created.actorType
    },
    createdAt: created.createdAt.toISOString()
  });
}
