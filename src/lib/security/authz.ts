import { RoomRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SessionUser } from "@/types/domain";

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export async function requireRoomRole(input: {
  roomId: string;
  user: SessionUser;
  allowed: RoomRole[];
}) {
  if (input.user.role === "ADMIN" || input.user.role === "MODERATOR") {
    return;
  }

  const membership = await prisma.roomMember.findUnique({
    where: {
      roomId_userId: {
        roomId: input.roomId,
        userId: input.user.id
      }
    }
  });

  if (!membership || !input.allowed.includes(membership.role)) {
    throw new AuthorizationError("Insufficient room permissions");
  }
}
