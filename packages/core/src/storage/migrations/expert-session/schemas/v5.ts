import { ExecutionStatusSchema, RuntimeContextRecordSchema } from "@pragma/shared";
import { z } from "zod";

export const ExpertSessionRecordV5Schema = z.object({
  schemaVersion: z.literal("pragma.expert-session/v5"),
  sessionId: z.string().min(1),
  expertId: z.string().min(1),
  definitionFingerprint: z.string().length(64),
  status: z.enum(["open", "closed"]),
  activeExecutionId: z.string().min(1).optional(),
  queuedRequestIds: z.array(z.string().min(1)),
  executionIds: z.array(z.string().min(1)),
  rootContextId: z.string().min(1),
  contexts: z.record(z.string(), RuntimeContextRecordSchema),
  lastStatus: ExecutionStatusSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ExpertSessionRecordV5 = z.infer<typeof ExpertSessionRecordV5Schema>;
