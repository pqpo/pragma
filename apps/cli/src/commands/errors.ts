import {
  IntegrationErrorCodeSchema,
  IntegrationErrorRetryPolicies,
  IntegrationErrorSchema,
  type IntegrationError,
  type IntegrationErrorCode,
} from "@pragma/local-host/wire";

import { isRecord } from "./utils.ts";

const HOST_ERROR_CODE_MAP: Readonly<Record<string, IntegrationErrorCode>> = {
  mission_not_found: "MISSION_NOT_FOUND",
  context_not_found: "BOARD_ITEM_NOT_FOUND",
  context_store_not_found: "PERMISSION_DENIED",
  context_store_scope_not_found: "PERMISSION_DENIED",
  permission_denied: "PERMISSION_DENIED",
  invalid_input: "INVALID_ARGUMENT",
  config_invalid: "STORAGE_CORRUPTED",
  unsupported_schema: "STORAGE_VERSION_UNSUPPORTED",
  dependency_unavailable: "DEPENDENCY_UNAVAILABLE",
};

export function toIntegrationError(
  error: unknown,
  fallback: IntegrationErrorCode = "INTERNAL_ERROR",
): IntegrationError {
  const parsed = IntegrationErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;

  const rawCode = isRecord(error) ? error["code"] : undefined;
  const mapped =
    typeof rawCode === "string"
      ? (IntegrationErrorCodeSchema.safeParse(rawCode).data ?? HOST_ERROR_CODE_MAP[rawCode])
      : undefined;
  const code = mapped ?? fallback;
  const message =
    code === "INTERNAL_ERROR"
      ? "The command could not complete."
      : (nonEmptyMessage(error) ?? "The command could not complete.");
  const details = safeDetails(error);
  const retryPolicy = IntegrationErrorRetryPolicies[code];
  return IntegrationErrorSchema.parse({
    code,
    schemaVersion: "pragma.integration-error/v1",
    category: categoryFor(code),
    message,
    ...(details === undefined ? {} : { details }),
    retryable: retryPolicy === "cause_dependent" ? false : retryPolicy,
  });
}

function nonEmptyMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (!isRecord(error)) return undefined;
  const message = error["message"];
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function categoryFor(code: IntegrationErrorCode) {
  if (
    code === "INVALID_ARGUMENT" ||
    code === "INVALID_FORMAT" ||
    code === "WORKSPACE_REQUIRED" ||
    code === "INPUT_SCHEMA_INVALID"
  )
    return "usage" as const;
  if (
    code === "NOT_FOUND" ||
    code === "EXECUTOR_NOT_FOUND" ||
    code === "MISSION_NOT_FOUND" ||
    code === "BOARD_ITEM_NOT_FOUND" ||
    code === "WORKSPACE_NOT_FOUND"
  )
    return "not_found" as const;
  if (
    code === "MISSION_LEASE_HELD" ||
    code === "MISSION_FENCING_REJECTED" ||
    code === "COMMAND_REJECTED" ||
    code === "COMMAND_EXPIRED" ||
    code === "COMMAND_ACK_TIMEOUT" ||
    code === "CURSOR_INVALID" ||
    code === "CURSOR_EXPIRED" ||
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "STEER_TARGET_NOT_ACTIVE" ||
    code === "STEER_TARGET_CHANGED" ||
    code === "INTERACTION_NOT_PENDING"
  )
    return "conflict" as const;
  if (
    code === "DEPENDENCY_UNAVAILABLE" ||
    code === "RUNTIME_UNAVAILABLE" ||
    code === "KEYCHAIN_UNAVAILABLE" ||
    code === "SECRET_MIGRATION_REQUIRED" ||
    code === "SECRET_STORE_LOCKED"
  )
    return "dependency" as const;
  if (code === "PERMISSION_DENIED" || code === "WORKSPACE_ACCESS_DENIED")
    return "permission" as const;
  if (
    code === "PROTOCOL_VERSION_UNSUPPORTED" ||
    code === "STORAGE_VERSION_UNSUPPORTED" ||
    code === "STORAGE_CORRUPTED"
  )
    return "protocol" as const;
  if (code === "INTERRUPTED") return "interrupted" as const;
  return "execution" as const;
}

function safeDetails(error: unknown): Record<string, never> | undefined {
  if (!isRecord(error)) return undefined;
  const details = error["details"];
  if (!isRecord(details)) return undefined;
  // Host errors already passed through the shared schema are handled above. For
  // foreign errors, do not copy arbitrary fields (paths, secrets, or causes).
  return undefined;
}
