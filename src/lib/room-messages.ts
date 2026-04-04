import { prisma } from "@/lib/prisma";

export const ROOM_MESSAGE_SNAPSHOT_LIMIT = 200;
export const ROOM_MESSAGE_PAGE = 100;

export const roomMessageInclude = {
  user: {
    select: { id: true, name: true, image: true }
  },
  evidence: {
    select: {
      id: true,
      sourceName: true,
      sourceUrl: true,
      snippet: true,
      stance: true
    }
  }
} as const;

export async function fetchRecentRoomMessagesChronological(roomId: string, take: number) {
  const batch = await prisma.roomMessage.findMany({
    where: { roomId },
    orderBy: { createdAt: "desc" },
    take,
    include: roomMessageInclude
  });

  return batch.slice().reverse();
}
