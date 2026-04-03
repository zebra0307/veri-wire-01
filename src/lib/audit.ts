import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function appendAuditLog(input: {
  roomId?: string;
  actorId?: string;
  actorType: "USER" | "AGENT" | "SYSTEM";
  action: string;
  payload: Prisma.InputJsonValue;
}) {
  await prisma.auditLog.create({
    data: {
      roomId: input.roomId,
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      payload: input.payload
    }
  });
}
