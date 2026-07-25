import { RuntimeSessionRefSchema } from "@pragma/shared";
import { z } from "zod";

export const RuntimeContextWindowUsageV3Schema = z.object({
  usedTokens: z.number().int().nonnegative().nullable(),
  contextWindowTokens: z.number().int().positive(),
  percent: z.number().nonnegative().nullable(),
  measurement: z.enum(["reported", "derived", "estimated"]),
  observedAt: z.string().datetime(),
});

export const RuntimeSessionRecordV3Schema = z.object({
  schemaVersion: z.literal("pragma.runtime-session/v3"),
  owner: z.object({
    type: z.enum(["expert-session", "flow-execution"]),
    ownerId: z.string().min(1),
    contextId: z.string().min(1).optional(),
    invocationId: z.string().min(1).optional(),
  }),
  systemSessionId: z.string().min(1),
  expertId: z.string().min(1),
  runtime: z.object({
    id: z.string().min(1),
    kind: z.string().min(1),
  }),
  runtimeSessionRef: RuntimeSessionRefSchema.nullable(),
  contextWindowUsage: RuntimeContextWindowUsageV3Schema.nullable().optional(),
  currentWorkspace: z.string().min(1),
  workspaceHistory: z.array(z.string().min(1)),
  processState: z.enum(["starting", "running", "stopped", "failed"]),
  retentionState: z.enum(["retained", "tombstoned", "trashed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RuntimeSessionRecordV3 = z.infer<typeof RuntimeSessionRecordV3Schema>;
