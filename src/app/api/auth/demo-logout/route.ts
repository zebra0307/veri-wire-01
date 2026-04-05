import { NextRequest, NextResponse } from "next/server";
import { DEMO_AUTH_COOKIE } from "@/lib/demo-auth";
import { env } from "@/lib/env";
import { jsonError } from "@/lib/http";

const defaultNextPath = "/login";

function normalizeNextPath(nextPath: string | null) {
  if (!nextPath || !nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return defaultNextPath;
  }

  return nextPath;
}

export async function GET(request: NextRequest) {
  if (!env.DEMO_BYPASS_AUTH) {
    return jsonError(403, { error: "Demo auth is disabled" });
  }

  const nextPath = normalizeNextPath(request.nextUrl.searchParams.get("next"));
  const response = NextResponse.redirect(new URL(nextPath, request.url));

  response.cookies.set({
    name: DEMO_AUTH_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0
  });

  return response;
}
