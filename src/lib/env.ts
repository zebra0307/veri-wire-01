import { z } from "zod";

const envSchema = z.object({
  NEXTAUTH_SECRET: z.string().min(16),
  NEXTAUTH_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
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
  DEMO_BYPASS_AUTH: z.enum(["true", "false"]).default("false"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  INTERNAL_AGENT_SECRET: z.string().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables", parsed.error.flatten().fieldErrors);
  throw new Error("Environment validation failed");
}

export const env = {
  ...parsed.data,
  DEMO_BYPASS_AUTH: parsed.data.DEMO_BYPASS_AUTH === "true"
};
