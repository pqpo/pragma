import { RuntimeSessionRefSchema } from "@pragma/shared";
import { z } from "zod";

export const RuntimeContextWindowUsageV4Schema = z.object({
  usedTokens: z.number().int().nonnegative().nullable(),
  contextWindowTokens: z.number().int().positive(),
  percent: z.number().nonnegative().nullable(),
  measurement: z.enum(["reported", "derived", "estimated"]),
  observedAt: z.string().datetime(),
});

export const RuntimeHostProcessSchema = z.object({
  type: z.literal("host"),
  processId: z.number().int().positive(),
  instanceId: z.string().uuid(),
  processStartToken: z.string().min(1).nullable(),
});
export type RuntimeHostProcess = z.infer<typeof RuntimeHostProcessSchema>;

export const RuntimeSessionRecordV4Schema = z.object({
  schemaVersion: z.literal("pragma.runtime-session/v4"),
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
  contextWindowUsage: RuntimeContextWindowUsageV4Schema.nullable().optional(),
  currentWorkspace: z.string().min(1),
  workspaceHistory: z.array(z.string().min(1)),
  processOwner: z
    .union([RuntimeHostProcessSchema, z.object({ type: z.literal("legacy-host") })])
    .nullable(),
  processState: z.enum(["starting", "running", "stopped", "failed"]),
  retentionState: z.enum(["retained", "tombstoned", "trashed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RuntimeSessionRecordV4 = z.infer<typeof RuntimeSessionRecordV4Schema>;
