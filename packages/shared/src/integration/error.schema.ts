import { z } from "zod";

import { JsonObjectSchema } from "./primitives.schema.ts";

export const IntegrationErrorCodeSchema = z.enum([
  "INVALID_ARGUMENT",
  "INVALID_FORMAT",
  "NOT_FOUND",
  "EXECUTOR_NOT_FOUND",
  "MISSION_NOT_FOUND",
  "BOARD_ITEM_NOT_FOUND",
  "CURSOR_INVALID",
  "CURSOR_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "MISSION_LEASE_HELD",
  "MISSION_FENCING_REJECTED",
  "COMMAND_REJECTED",
  "COMMAND_EXPIRED",
  "COMMAND_ACK_TIMEOUT",
  "STEER_TARGET_NOT_ACTIVE",
  "STEER_TARGET_CHANGED",
  "INTERACTION_NOT_PENDING",
  "WORKSPACE_REQUIRED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
  "INPUT_SCHEMA_INVALID",
  "DEPENDENCY_UNAVAILABLE",
  "RUNTIME_UNAVAILABLE",
  "KEYCHAIN_UNAVAILABLE",
  "SECRET_MIGRATION_REQUIRED",
  "SECRET_STORE_LOCKED",
  "PERMISSION_DENIED",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "STORAGE_VERSION_UNSUPPORTED",
  "STORAGE_CORRUPTED",
  "EXECUTION_FAILED",
  "INTERRUPTED",
  "INTERNAL_ERROR",
]);

export const IntegrationErrorCategorySchema = z.enum([
  "usage",
  "not_found",
  "conflict",
  "dependency",
  "permission",
  "protocol",
  "execution",
  "interrupted",
]);

export const IntegrationExitCodeSchema = z.union([
  z.literal(0),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(10),
  z.literal(130),
]);

export const IntegrationErrorSchema = z
  .object({
    schemaVersion: z.literal("pragma.integration-error/v1"),
    code: IntegrationErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    category: IntegrationErrorCategorySchema,
    details: JsonObjectSchema.optional(),
    causeId: z.string().uuid().optional(),
  })
  .strict();

export const IntegrationWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: JsonObjectSchema.optional(),
  })
  .strict();

export const IntegrationErrorExitCodes = {
  INVALID_ARGUMENT: 2,
  INVALID_FORMAT: 2,
  NOT_FOUND: 3,
  EXECUTOR_NOT_FOUND: 3,
  MISSION_NOT_FOUND: 3,
  BOARD_ITEM_NOT_FOUND: 3,
  CURSOR_INVALID: 2,
  CURSOR_EXPIRED: 4,
  IDEMPOTENCY_CONFLICT: 4,
  MISSION_LEASE_HELD: 4,
  MISSION_FENCING_REJECTED: 4,
  COMMAND_REJECTED: 4,
  COMMAND_EXPIRED: 4,
  COMMAND_ACK_TIMEOUT: 4,
  STEER_TARGET_NOT_ACTIVE: 4,
  STEER_TARGET_CHANGED: 4,
  INTERACTION_NOT_PENDING: 4,
  WORKSPACE_REQUIRED: 2,
  WORKSPACE_NOT_FOUND: 3,
  WORKSPACE_ACCESS_DENIED: 6,
  INPUT_SCHEMA_INVALID: 2,
  DEPENDENCY_UNAVAILABLE: 5,
  RUNTIME_UNAVAILABLE: 5,
  KEYCHAIN_UNAVAILABLE: 5,
  SECRET_MIGRATION_REQUIRED: 5,
  SECRET_STORE_LOCKED: 5,
  PERMISSION_DENIED: 6,
  PROTOCOL_VERSION_UNSUPPORTED: 7,
  STORAGE_VERSION_UNSUPPORTED: 7,
  STORAGE_CORRUPTED: 7,
  EXECUTION_FAILED: 10,
  INTERRUPTED: 130,
  INTERNAL_ERROR: 10,
} as const satisfies Record<
  z.infer<typeof IntegrationErrorCodeSchema>,
  z.infer<typeof IntegrationExitCodeSchema>
>;

export function integrationErrorExitCode(
  code: z.infer<typeof IntegrationErrorCodeSchema>,
): z.infer<typeof IntegrationExitCodeSchema> {
  return IntegrationErrorExitCodes[code];
}

export type IntegrationErrorCode = z.infer<typeof IntegrationErrorCodeSchema>;
export type IntegrationError = z.infer<typeof IntegrationErrorSchema>;
export type IntegrationWarning = z.infer<typeof IntegrationWarningSchema>;
