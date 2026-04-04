import { z } from "zod";

const emptyToUndefined = (value: unknown) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
};

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

const envSchema = z.object({
  NEXTAUTH_SECRET: z.string().min(16).default("dev-nextauth-secret-change-me"),
  NEXTAUTH_URL: z.string().url().default("http://localhost:3000"),
  /** Supabase: Project Settings → Database → URI (use direct IPv4 or pooler with `?pgbouncer=true` for Prisma). */
  DATABASE_URL: z.string().min(1, "Set DATABASE_URL to your Supabase Postgres connection string"),
  /** Optional: Supabase project URL (for @/lib/supabase-server helpers). Database access uses DATABASE_URL + Prisma. */
  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  REDIS_URL: optionalString,
  GITHUB_ID: optionalString,
  GITHUB_SECRET: optionalString,
  EMAIL_SERVER_HOST: optionalString,
  EMAIL_SERVER_PORT: optionalString,
  EMAIL_SERVER_USER: optionalString,
  EMAIL_SERVER_PASSWORD: optionalString,
  EMAIL_FROM: optionalString,
  GEMINI_API_KEY: optionalString,
  BRAVE_SEARCH_API_KEY: optionalString,
  ELEVENLABS_API_KEY: optionalString,
  SPACETIMEDB_ENDPOINT: optionalUrl,
  SPACETIMEDB_API_KEY: optionalString,
  SUPERPLANE_WEBHOOK_URL: optionalUrl,
  SUPERPLANE_SECRET: optionalString,
  DEMO_BYPASS_AUTH: z.enum(["true", "false"]).default("false"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  INTERNAL_AGENT_SECRET: optionalString
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  throw new Error("Environment validation failed");
}

if (process.env.NODE_ENV === "production") {
  const required = ["NEXTAUTH_SECRET", "NEXTAUTH_URL", "DATABASE_URL"];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable in production: ${key}`);
    }
  }
}

export const env = {
  ...parsed.data,
  DEMO_BYPASS_AUTH: parsed.data.DEMO_BYPASS_AUTH === "true"
};
