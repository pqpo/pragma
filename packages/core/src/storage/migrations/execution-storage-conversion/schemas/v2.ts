import { z } from "zod";
export const ExecutionStorageConversionSchema = z
  .object({
    schemaVersion: z.literal("pragma.execution-storage-conversion/v2"),
    executionId: z.string(),
    handoffNames: z.array(z.string()).optional(),
    phase: z.enum(["backup", "import", "publish"]),
    sourceFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    importedEvents: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ExecutionStorageConversion = z.infer<typeof ExecutionStorageConversionSchema>;
