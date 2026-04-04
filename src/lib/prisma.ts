import { PrismaClient } from "@prisma/client";

/** Connects to Postgres; use Supabase `DATABASE_URL` from Project Settings → Database. */

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

export const prisma =
  global.prismaGlobal ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  global.prismaGlobal = prisma;
}
