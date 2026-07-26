import { z } from "zod";

export type PragmaJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PragmaJsonValue[]
  | { readonly [key: string]: PragmaJsonValue };

export const PragmaJsonValueSchema: z.ZodType<PragmaJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(PragmaJsonValueSchema),
    z.record(z.string(), PragmaJsonValueSchema),
  ]),
);

export const PragmaLogLevelSchema = z.enum(["debug", "info", "warn", "error", "fatal"]);
export const PragmaLogStreamSchema = z.enum(["operation", "failure"]);

export const PragmaLogScopeSchema = z
  .object({
    processKind: z.string().trim().min(1).optional(),
    operationId: z.string().trim().min(1).optional(),
    parentOperationId: z.string().trim().min(1).optional(),
    requestId: z.string().trim().min(1).optional(),
    missionId: z.string().trim().min(1).optional(),
    executionId: z.string().trim().min(1).optional(),
    expertSessionId: z.string().trim().min(1).optional(),
    invocationId: z.string().trim().min(1).optional(),
    contextId: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    runtimeId: z.string().trim().min(1).optional(),
    systemSessionId: z.string().trim().min(1).optional(),
    runtimeSessionType: z.string().trim().min(1).optional(),
    runtimeSessionId: z.string().trim().min(1).optional(),
    pluginId: z.string().trim().min(1).optional(),
  })
  .strict();

export interface PragmaLogError {
  readonly code: string;
  readonly name: string;
  readonly message: string;
  readonly stack?: string | undefined;
  readonly classification:
    | "validation"
    | "permission"
    | "cancelled"
    | "timeout"
    | "conflict"
    | "not-found"
    | "storage"
    | "runtime"
    | "external"
    | "invariant"
    | "unknown";
  readonly retryable: boolean;
  readonly cause?: PragmaLogError | undefined;
  readonly errors?: readonly PragmaLogError[] | undefined;
}

export const PragmaLogErrorSchema: z.ZodType<PragmaLogError> = z.lazy(() =>
  z
    .object({
      code: z.string().trim().min(1),
      name: z.string().trim().min(1),
      message: z.string(),
      stack: z.string().optional(),
      classification: z.enum([
        "validation",
        "permission",
        "cancelled",
        "timeout",
        "conflict",
        "not-found",
        "storage",
        "runtime",
        "external",
        "invariant",
        "unknown",
      ]),
      retryable: z.boolean(),
      cause: PragmaLogErrorSchema.optional(),
      errors: z.array(PragmaLogErrorSchema).optional(),
    })
    .strict(),
);

const PragmaLogRecordBaseSchema = z.object({
  schemaVersion: z.literal("pragma.log/v1"),
  recordId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  host: z
    .object({
      kind: z.string().trim().min(1),
      bootId: z.string().uuid(),
      pid: z.number().int().positive().optional(),
      version: z.string().trim().min(1).optional(),
    })
    .strict(),
  component: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  event: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  message: z.string().trim().min(1),
  scope: PragmaLogScopeSchema,
  attributes: z.record(z.string(), PragmaJsonValueSchema).optional(),
});

export const PragmaOperationLogRecordSchema = PragmaLogRecordBaseSchema.extend({
  stream: z.literal("operation"),
  level: z.enum(["debug", "info", "warn"]),
}).strict();

export const PragmaFailureLogRecordSchema = PragmaLogRecordBaseSchema.extend({
  stream: z.literal("failure"),
  level: z.enum(["error", "fatal"]),
  diagnosticId: z.string().uuid(),
  error: PragmaLogErrorSchema,
}).strict();

export const PragmaLogRecordSchema = z.discriminatedUnion("stream", [
  PragmaOperationLogRecordSchema,
  PragmaFailureLogRecordSchema,
]);

export type PragmaLogLevel = z.infer<typeof PragmaLogLevelSchema>;
export type PragmaLogStream = z.infer<typeof PragmaLogStreamSchema>;
export type PragmaLogScope = z.infer<typeof PragmaLogScopeSchema>;
export type PragmaLogRecord = z.infer<typeof PragmaLogRecordSchema>;
export type PragmaOperationLogRecord = z.infer<typeof PragmaOperationLogRecordSchema>;
export type PragmaFailureLogRecord = z.infer<typeof PragmaFailureLogRecordSchema>;
