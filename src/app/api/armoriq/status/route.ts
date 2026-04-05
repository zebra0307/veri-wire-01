import { NextResponse } from "next/server";
import { checkArmorIQProxyHealth, isArmoriqConfigured } from "@/lib/armoriq";

/**
 * Public diagnostics: whether ArmorIQ env is present and proxy health (no secrets).
 */
export async function GET() {
  const configured = isArmoriqConfigured();
  const key = process.env.ARMORIQ_API_KEY?.trim();
  const environment = process.env.ARMORIQ_ENV === "development" ? "development" : "production";

  if (!configured || !key) {
    return NextResponse.json({
      configured: false,
      environment,
      proxy: null as { ok: boolean; status: number } | null
    });
  }

  const proxy = await checkArmorIQProxyHealth(key);

  return NextResponse.json({
    configured: true,
    environment,
    proxy: {
      ok: proxy.ok,
      status: proxy.status
    }
  });
}
