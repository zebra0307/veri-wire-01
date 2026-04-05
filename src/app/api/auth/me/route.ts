import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDemoAccountByEmail } from "@/lib/demo-auth";
import { env } from "@/lib/env";
import { handleRouteError } from "@/lib/http";

export async function GET() {
  try {
    const user = await getSessionUser();
    const demoAccount = env.DEMO_BYPASS_AUTH ? getDemoAccountByEmail(user.email) : null;

    return NextResponse.json({
      user,
      demoMode: env.DEMO_BYPASS_AUTH,
      demoAccountId: demoAccount?.id ?? null,
      demoReadOnly: false
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
