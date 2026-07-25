import { RuntimeSessionRefSchema } from "@pragma/shared";
import { z } from "zod";

export const RuntimeSessionRecordV2Schema = z.object({
  schemaVersion: z.literal("pragma.runtime-session/v2"),
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
  currentWorkspace: z.string().min(1),
  workspaceHistory: z.array(z.string().min(1)),
  processState: z.enum(["starting", "running", "stopped", "failed"]),
  retentionState: z.enum(["retained", "tombstoned", "trashed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RuntimeSessionRecordV2 = z.infer<typeof RuntimeSessionRecordV2Schema>;
