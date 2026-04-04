import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let adminClient: SupabaseClient | null | undefined;

/** Service-role client for Storage, Auth admin, etc. Returns null if not configured. */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (adminClient !== undefined) {
    return adminClient;
  }

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    adminClient = null;
    return null;
  }

  adminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return adminClient;
}
