import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

function normalizeForSimilarity(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return new Set(normalizeForSimilarity(value).split(" ").filter(Boolean));
}

function jaccard(a: string, b: string) {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const item of setA) {
    if (setB.has(item)) {
      intersection += 1;
    }
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

export function fingerprintClaim(claim: string) {
  const normalized = normalizeForSimilarity(claim);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export async function detectDuplicateOrRelatedClaim(claimNormalized: string) {
  const candidates = await prisma.room.findMany({
    select: {
      id: true,
      claimNormalized: true,
      status: true,
      recurrenceCount: true,
      createdAt: true,
      verdict: true
    },
    orderBy: { createdAt: "desc" },
    take: 200
  });

  let bestRelated: {
    roomId: string;
    score: number;
  } | null = null;

  for (const room of candidates) {
    const score = jaccard(claimNormalized, room.claimNormalized);

    if (score > 0.85) {
      return {
        exact: {
          roomId: room.id,
          score
        },
        related: bestRelated
      };
    }

    if (score >= 0.6 && (!bestRelated || score > bestRelated.score)) {
      bestRelated = {
        roomId: room.id,
        score
      };
    }
  }

  return {
    exact: null,
    related: bestRelated
  };
}
