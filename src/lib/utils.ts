import { customAlphabet } from "nanoid";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

const roomIdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const roomIdGenerator = customAlphabet(roomIdAlphabet, 8);

export function createRoomId() {
  return roomIdGenerator();
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
