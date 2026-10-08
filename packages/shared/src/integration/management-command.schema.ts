import { z } from "zod";
import { IntegrationErrorSchema, IntegrationExitCodeSchema } from "./error.schema.ts";
import { JsonObjectSchema, JsonValueSchema, RequestIdSchema } from "./primitives.schema.ts";

/** Independent, additive protocol; does not change native Runtime MCP results. */
export const MANAGEMENT_COMMAND_PROTOCOL = "pragma.management-command/v1" as const;
export const ManagementCommandSchema = z.enum([
  "flow.draft.create",
  "flow.draft.get",
  "flow.draft.update",
  "flow.draft.validate",
  "flow.draft.prepare",
  "flow.draft.discard",
  "dsl.resources.list",
  "dsl.resources.read",
  "dsl.options.list",
  "dsl.ids.allocate",
  "dsl.changes.read",
  "dsl.changes.commit",
]);
export const ManagementCommandRequestSchema = z
  .object({
    protocol: z.literal(MANAGEMENT_COMMAND_PROTOCOL),
    requestId: RequestIdSchema,
    command: ManagementCommandSchema,
    input: JsonObjectSchema,
  })
  .strict();
export const ManagementCommandResultSchema = z
  .object({
    protocol: z.literal(MANAGEMENT_COMMAND_PROTOCOL),
    requestId: RequestIdSchema,
    command: ManagementCommandSchema,
    exitCode: IntegrationExitCodeSchema,
    status: z.enum(["succeeded", "invalid", "failed", "input_required"]),
    origin: z
      .object({
        missionId: z.string().uuid(),
        executionId: z.string().min(1),
        invocationId: z.string().min(1),
        contextId: z.string().min(1),
      })
      .strict()
      .optional(),
    result: JsonValueSchema.optional(),
    error: IntegrationErrorSchema.optional(),
  })
  .strict();
export type ManagementCommand = z.infer<typeof ManagementCommandSchema>;
export type ManagementCommandRequest = z.infer<typeof ManagementCommandRequestSchema>;
export type ManagementCommandResult = z.infer<typeof ManagementCommandResultSchema>;

/** Preserve existing integration error codes/exit codes at the new wire boundary. */
export function managementCommandError(
  code: import("./error.schema.ts").IntegrationErrorCode,
  message: string,
  details?: unknown,
) {
  const category =
    code === "PERMISSION_DENIED" || code === "WORKSPACE_ACCESS_DENIED"
      ? "permission"
      : code === "PROTOCOL_VERSION_UNSUPPORTED" ||
          code === "STORAGE_VERSION_UNSUPPORTED" ||
          code === "STORAGE_CORRUPTED"
        ? "protocol"
        : code === "DEPENDENCY_UNAVAILABLE"
          ? "dependency"
          : code === "INVALID_ARGUMENT" || code === "INVALID_FORMAT" || code === "CURSOR_INVALID"
            ? "usage"
            : code === "NOT_FOUND"
              ? "not_found"
              : code === "INTERRUPTED"
                ? "interrupted"
                : code === "INTERNAL_ERROR" || code === "EXECUTION_FAILED"
                  ? "execution"
                  : "conflict";
  return IntegrationErrorSchema.parse({
    schemaVersion: "pragma.integration-error/v1",
    code,
    message,
    category,
    retryable: ["DEPENDENCY_UNAVAILABLE", "CURSOR_EXPIRED", "COMMAND_RESULT_TIMEOUT"].includes(
      code,
    ),
    ...(details === undefined ? {} : { details }),
  });
}
