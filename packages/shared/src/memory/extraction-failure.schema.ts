import { z } from "zod";

export const MEMORY_EXTRACTION_FAILURE_SCHEMA_VERSION =
  "pragma.memory-extraction-failure/v1" as const;

export const MemoryExtractionFailurePhaseSchema = z.enum([
  "source_read",
  "target_read",
  "curator_run",
  "output_parse",
  "validation",
  "promotion",
  "storage",
]);

export const MemoryExtractionRuntimeTargetSchema = z
  .object({
    runtimeId: z.string().min(1),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    endpoint: z.string().min(1).max(2_048).optional(),
  })
  .strict();

export const MemoryExtractionTransportDiagnosticSchema = z
  .object({
    httpStatus: z.number().int().min(100).max(599).optional(),
    requestId: z.string().min(1).max(500).optional(),
  })
  .strict();

export const MemoryExtractionFailureDiagnosticSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_EXTRACTION_FAILURE_SCHEMA_VERSION),
    code: z.string().min(1).max(200),
    message: z.string().min(1).max(4_096),
    phase: MemoryExtractionFailurePhaseSchema,
    failedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    retryable: z.boolean().optional(),
    runtime: MemoryExtractionRuntimeTargetSchema.optional(),
    transport: MemoryExtractionTransportDiagnosticSchema.optional(),
  })
  .strict();

export const MemoryExtractionFailureAttemptSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-extraction-failure-attempt/v1"),
    id: z.string().min(1),
    jobId: z.string().min(1),
    jobRevision: z.number().int().positive(),
    attempt: z.number().int().positive(),
    diagnostic: MemoryExtractionFailureDiagnosticSchema,
    stack: z.string().min(1).max(8_192).optional(),
  })
  .strict();

export type MemoryExtractionFailurePhase = z.infer<typeof MemoryExtractionFailurePhaseSchema>;
export type MemoryExtractionFailureDiagnostic = z.infer<
  typeof MemoryExtractionFailureDiagnosticSchema
>;
export type MemoryExtractionFailureAttempt = z.infer<typeof MemoryExtractionFailureAttemptSchema>;
