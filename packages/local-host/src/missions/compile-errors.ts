import { PragmaDslError, PragmaResourceNeedsAttentionError } from "@pragma/interpreter";
import {
  createIntegrationError,
  IntegrationErrorSchema,
  type IntegrationErrorCode,
} from "@pragma/shared/integration";

import { CapabilityStoreError } from "../resources/capability-reader.ts";
import { ContextStoreStoreError } from "../resources/context-store-reader.ts";
import { CapabilityCredentialStoreError } from "../resources/capability-credential-store.ts";
import { PluginCredentialStoreError } from "../resources/plugin-credential-store.ts";
import { PluginStoreError } from "../resources/plugin-resolver.ts";
import { LocalHostResourceUnavailableError } from "../resources/resolvers.ts";
import { LegacyCredentialMigrationError } from "../secrets/legacy-credential-migration.ts";
import { SecretStoreError } from "../secrets/secret-store.ts";

/** Translate recognized Host failures without changing ordinary DSL validation failures. */
export async function withLocalHostCompilationErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw localHostCompilationError(error);
  }
}

export function localHostCompilationError(error: unknown): unknown {
  if (IntegrationErrorSchema.safeParse(error).success) return error;
  if (error instanceof PragmaResourceNeedsAttentionError) {
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 5 && cause !== undefined; depth += 1) {
      if (IntegrationErrorSchema.safeParse(cause).success) return cause;
      if (isHostResourceError(cause)) {
        const translated = IntegrationErrorSchema.safeParse(localHostCompilationError(cause));
        if (translated.success)
          return createIntegrationError({
            code: translated.data.code,
            category: translated.data.category,
            message: translated.data.message,
            details: {
              ...translated.data.details,
              diagnostics: error.health.issues.map((issue) => ({
                code: issue.code,
                severity: issue.severity,
                message: issue.message,
                path: [...issue.path],
                ...(issue.source === undefined ? {} : { source: issue.source }),
                ...(issue.resourceRef === undefined ? {} : { resourceRef: issue.resourceRef }),
              })),
            },
          });
      }
      cause = cause instanceof Error ? cause.cause : undefined;
    }
  }
  if (error instanceof PragmaDslError || error instanceof PragmaResourceNeedsAttentionError) {
    const diagnostics = error instanceof PragmaDslError ? error.diagnostics : error.health.issues;
    if (
      !diagnostics.some(
        (issue) =>
          issue.severity === "error" &&
          (issue.code === "environment.resource_unavailable" ||
            issue.code === "environment.plugin_unavailable"),
      )
    )
      return error;
    return createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: error.message,
      details: {
        diagnostics: diagnostics.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
          path: [...issue.path],
          ...(issue.source === undefined ? {} : { source: issue.source }),
          ...(issue.resourceRef === undefined ? {} : { resourceRef: issue.resourceRef }),
        })),
      },
    });
  }
  if (error instanceof LocalHostResourceUnavailableError)
    return createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: error.message,
      details: error.details,
    });
  if (!isHostResourceError(error)) return error;
  const code = readerErrorCode(error.code);
  if (code === undefined) return error;
  return createIntegrationError({
    code,
    category:
      code === "STORAGE_VERSION_UNSUPPORTED" || code === "STORAGE_CORRUPTED"
        ? "protocol"
        : "dependency",
    message: error.message,
    details: { diagnosticCode: error.code },
  });
}

function isHostResourceError(error: unknown): error is Error & { readonly code: string } {
  return (
    error instanceof LocalHostResourceUnavailableError ||
    error instanceof CapabilityStoreError ||
    error instanceof ContextStoreStoreError ||
    error instanceof CapabilityCredentialStoreError ||
    error instanceof PluginCredentialStoreError ||
    error instanceof PluginStoreError ||
    error instanceof SecretStoreError ||
    error instanceof LegacyCredentialMigrationError
  );
}

function readerErrorCode(
  code: string,
):
  | Exclude<IntegrationErrorCode, "COMMAND_RESULT_TIMEOUT" | "EXECUTION_FAILED" | "INTERNAL_ERROR">
  | undefined {
  switch (code) {
    case "capability_not_found":
    case "plugin_not_found":
    case "version_conflict":
    case "capability_incompatible":
    case "secret_unavailable":
    case "mutation_pending":
    case "store_not_found":
    case "source_unavailable":
      return "DEPENDENCY_UNAVAILABLE";
    case "config_invalid":
    case "SECRET_MIGRATION_FAILED":
    case "SECRET_STORE_CORRUPTED":
    case "SECRET_MASTER_KEY_MISSING":
      return "STORAGE_CORRUPTED";
    case "unsupported_version":
    case "SECRET_MIGRATION_FUTURE_VERSION":
      return "STORAGE_VERSION_UNSUPPORTED";
    case "migration_required":
    case "SECRET_MIGRATION_REQUIRED":
      return "SECRET_MIGRATION_REQUIRED";
    case "KEYCHAIN_UNAVAILABLE":
    case "SECRET_STORE_LOCKED":
      return code;
    default:
      return undefined;
  }
}
