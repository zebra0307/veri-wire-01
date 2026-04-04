import { z } from "zod";

export const claimSubmissionSchema = z.object({
  claimText: z.string().min(1).max(1000),
  sourceType: z.enum(["TEXT", "URL", "IMAGE"]).default("TEXT"),
  claimUrl: z.string().url().optional(),
  imageMime: z.string().optional(),
  imageSize: z.number().int().optional(),
  mergeWithRoomId: z.string().optional()
});

export const evidenceSchema = z.object({
  sourceUrl: z.string().url(),
  stance: z.enum(["SUPPORTS", "REFUTES", "CONTEXT"]),
  snippet: z.string().min(1).max(300).optional()
});

export const voteSchema = z.object({
  verdict: z.enum(["TRUE", "FALSE", "UNCLEAR"])
});

export const statusSchema = z.object({
  status: z.enum(["OPEN", "INVESTIGATING", "PENDING_VERDICT", "CLOSED"]),
  verdict: z.enum(["TRUE", "FALSE", "UNCLEAR"]).optional(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).optional()
});

export const removeEvidenceSchema = z.object({
  evidenceId: z.string().min(1)
});

export const roomMessageSchema = z
  .object({
    body: z.string().min(1).max(2000),
    kind: z.enum(["CHAT", "PROOF_NOTE"]).default("CHAT"),
    evidenceId: z.string().min(1).optional()
  })
  .refine((data) => data.kind !== "PROOF_NOTE" || Boolean(data.evidenceId), {
    message: "PROOF_NOTE requires evidenceId"
  });
