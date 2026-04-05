import { NextRequest, NextResponse } from "next/server";
import { DEMO_AUTH_COOKIE, getDemoAccountById } from "@/lib/demo-auth";
import { env } from "@/lib/env";
import { jsonError } from "@/lib/http";
import { prisma } from "@/lib/prisma";

const defaultNextPath = "/app";

function normalizeNextPath(nextPath: string | null) {
  if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return defaultNextPath;
  }

  return nextPath;
}

export async function GET(request: NextRequest) {
  if (!env.DEMO_BYPASS_AUTH) {
    return jsonError(403, { error: "Demo login is disabled" });
  }

  const accountId = request.nextUrl.searchParams.get("account");
  const demoAccount = getDemoAccountById(accountId);

  if (!demoAccount) {
    return jsonError(400, { error: "Unknown demo account" });
  }

  await prisma.user.upsert({
    where: {
      email: demoAccount.email
    },
    update: {
      name: demoAccount.name,
      role: demoAccount.role,
      contributorScore: demoAccount.contributorScore
    },
    create: {
      email: demoAccount.email,
      name: demoAccount.name,
      role: demoAccount.role,
      contributorScore: demoAccount.contributorScore
    }
  });

  const nextPath = normalizeNextPath(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.redirect(new URL(nextPath, request.url));

  response.cookies.set({
    name: DEMO_AUTH_COOKIE,
    value: demoAccount.id,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });

  return response;
}
