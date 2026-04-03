import { getRedisClient } from "@/lib/redis";

type RateLimitInput = {
  key: string;
  limit: number;
  windowSeconds: number;
};

const memoryStore = new Map<string, number[]>();

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

async function enforceMemoryRateLimit(input: RateLimitInput) {
  const now = Date.now();
  const threshold = now - input.windowSeconds * 1000;
  const existing = memoryStore.get(input.key) ?? [];
  const alive = existing.filter((timestamp) => timestamp > threshold);

  if (alive.length >= input.limit) {
    throw new RateLimitError(`Rate limit exceeded for ${input.key}`);
  }

  alive.push(now);
  memoryStore.set(input.key, alive);
}

export async function enforceRateLimit(input: RateLimitInput) {
  const redis = getRedisClient();

  if (!redis) {
    await enforceMemoryRateLimit(input);
    return;
  }

  const redisKey = `ratelimit:${input.key}`;
  const currentCount = await redis.incr(redisKey);

  if (currentCount === 1) {
    await redis.expire(redisKey, input.windowSeconds);
  }

  if (currentCount > input.limit) {
    throw new RateLimitError(`Rate limit exceeded for ${input.key}`);
  }
}
