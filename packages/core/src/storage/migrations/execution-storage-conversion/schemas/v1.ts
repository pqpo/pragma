import { z } from "zod";
export const ExecutionStorageConversionV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.execution-storage-conversion/v1"),
    executionId: z.string(),
    handoffNames: z.array(z.string()).optional(),
  })
  .strict();
