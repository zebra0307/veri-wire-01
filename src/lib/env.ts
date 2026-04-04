import { z } from "zod";

const envSchema = z.object({
  NEXTAUTH_SECRET: z.string().min(16).default("dev-nextauth-secret-change-me"),
  NEXTAUTH_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("postgresql://veriwire:veriwire@localhost:5432/veriwire"),
  REDIS_URL: z.string().optional(),
  GITHUB_ID: z.string().optional(),
  GITHUB_SECRET: z.string().optional(),
  EMAIL_SERVER_HOST: z.string().optional(),
  EMAIL_SERVER_PORT: z.string().optional(),
  EMAIL_SERVER_USER: z.string().optional(),
  EMAIL_SERVER_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  SPACETIMEDB_ENDPOINT: z.string().url().optional(),
  SPACETIMEDB_API_KEY: z.string().optional(),
  SUPERPLANE_WEBHOOK_URL: z.string().url().optional(),
  SUPERPLANE_SECRET: z.string().optional(),
  DEMO_BYPASS_AUTH: z.enum(["true", "false"]).default("false"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  INTERNAL_AGENT_SECRET: z.string().optional()
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
