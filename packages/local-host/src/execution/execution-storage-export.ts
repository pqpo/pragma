import { z } from "zod";
import {
  ExecutionRecordSchema,
  InvocationSchema,
  AgentInstanceSchema,
  RuntimeContextRecordSchema,
  ExecutionEventSchema,
  CanonicalEventEnvelopeSchema,
} from "@pragma/shared";

/** Portable owner export, including idempotency receipts and undelivered facts. */
export const ExecutionStorageExportSchema = z
  .object({
    schemaVersion: z.literal("pragma.execution-storage-export/v1"),
    execution: ExecutionRecordSchema,
    invocations: z.array(InvocationSchema),
    agents: z.array(AgentInstanceSchema),
    contexts: z.array(RuntimeContextRecordSchema),
    events: z.array(ExecutionEventSchema),
    commits: z.array(
      z
        .object({
          commitId: z.string(),
          signature: z.string(),
          committedVersion: z.number().int().nonnegative(),
          eventIds: z.array(z.string()),
        })
        .strict(),
    ),
    pendingCanonicalEvents: z.array(CanonicalEventEnvelopeSchema),
  })
  .strict();

export type ExecutionStorageExport = z.infer<typeof ExecutionStorageExportSchema>;
