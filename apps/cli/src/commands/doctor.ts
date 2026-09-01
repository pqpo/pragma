import {
  IntegrationErrorCodeSchema,
  IntegrationErrorRetryPolicies,
  IntegrationErrorSchema,
  type IntegrationError,
  type IntegrationErrorCode,
  type JsonValue,
} from "@pragma/shared/integration";
import type { CredentialDoctorFinding, OsKeychain } from "@pragma/local-host";

export interface DoctorDependencies {
  readonly inspectCredentialMigration?: () => Promise<readonly CredentialDoctorFinding[]>;
}

export class DoctorFailure extends Error {
  readonly error: IntegrationError;
  readonly findings: readonly CredentialDoctorFinding[] | undefined;

  constructor(error: IntegrationError, findings?: readonly CredentialDoctorFinding[]) {
    super(error.message);
    this.name = "DoctorFailure";
    this.error = error;
    this.findings = findings;
  }
}

export async function runDoctorCommand(dependencies: DoctorDependencies): Promise<JsonValue> {
  let findings: readonly CredentialDoctorFinding[];
  try {
    if (dependencies.inspectCredentialMigration !== undefined) {
      findings = await dependencies.inspectCredentialMigration();
    } else {
      let host: typeof import("@pragma/local-host");
      try {
        host = await import("@pragma/local-host");
      } catch {
        findings = unavailableFindings();
        throw new DoctorFailure(createDoctorError("KEYCHAIN_UNAVAILABLE"), findings);
      }
      findings = await inspectCliCredentialMigration(host);
    }
  } catch (error) {
    if (error instanceof DoctorFailure) throw error;
    const code = codeForError(error);
    throw new DoctorFailure(createDoctorError(code));
  }

  const code = selectPrimaryDoctorCode(findings);
  if (code !== undefined) throw new DoctorFailure(createDoctorError(code, findings), findings);
  return { credentials: findings.map(findingToJson) };
}

async function inspectCliCredentialMigration(
  host: typeof import("@pragma/local-host"),
): Promise<readonly CredentialDoctorFinding[]> {
  const keychain = testKeychainFromEnvironment();
  return await host.inspectDefaultCredentialMigration({
    pragmaHome: process.env["PRAGMA_HOME"],
    ...(keychain === undefined ? {} : { keychain }),
  });
}

export function codeForError(error: unknown): IntegrationErrorCode {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  const parsed = IntegrationErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "INTERNAL_ERROR";
}

/** Stable doctor aggregation policy, ordered by severity then fixed code order. */
const DoctorCodePrecedence = [
  "INTERNAL_ERROR",
  "EXECUTION_FAILED",
  "STORAGE_VERSION_UNSUPPORTED",
  "STORAGE_CORRUPTED",
  "PROTOCOL_VERSION_UNSUPPORTED",
  "PERMISSION_DENIED",
  "WORKSPACE_ACCESS_DENIED",
  "KEYCHAIN_UNAVAILABLE",
  "SECRET_MIGRATION_REQUIRED",
  "SECRET_STORE_LOCKED",
  "DEPENDENCY_UNAVAILABLE",
  "RUNTIME_UNAVAILABLE",
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
  "COMMAND_ACCEPTANCE_TIMEOUT",
  "COMMAND_RESULT_TIMEOUT",
  "STEER_TARGET_NOT_ACTIVE",
  "STEER_TARGET_CHANGED",
  "INTERACTION_NOT_PENDING",
  "WORKSPACE_REQUIRED",
  "WORKSPACE_NOT_FOUND",
  "INPUT_SCHEMA_INVALID",
  "INTERRUPTED",
] as const satisfies readonly IntegrationErrorCode[];

const DoctorCodeRank = new Map<IntegrationErrorCode, number>(
  DoctorCodePrecedence.map((code, index) => [code, index]),
);

export function selectPrimaryDoctorCode(
  findings: readonly CredentialDoctorFinding[],
): IntegrationErrorCode | undefined {
  return findings.reduce<IntegrationErrorCode | undefined>((selected, finding) => {
    if (finding.code === undefined) return selected;
    if (selected === undefined) return finding.code;
    return DoctorCodeRank.get(finding.code)! < DoctorCodeRank.get(selected)!
      ? finding.code
      : selected;
  }, undefined);
}

function createDoctorError(
  code: IntegrationErrorCode,
  findings?: readonly CredentialDoctorFinding[],
): IntegrationError {
  const details = findings === undefined ? undefined : { credentials: findings.map(findingToJson) };
  const input = {
    schemaVersion: "pragma.integration-error/v1" as const,
    code,
    category: doctorCategory(code),
    message: doctorMessage(code),
    ...(details === undefined ? {} : { details }),
  };
  return IntegrationErrorSchema.parse({
    ...input,
    retryable:
      IntegrationErrorRetryPolicies[code] === "cause_dependent"
        ? false
        : IntegrationErrorRetryPolicies[code],
  });
}

function findingToJson(finding: CredentialDoctorFinding): JsonValue {
  return finding.code === undefined
    ? { module: finding.module, status: finding.status }
    : { module: finding.module, status: finding.status, code: finding.code };
}

function doctorCategory(code: IntegrationErrorCode) {
  if (code === "PERMISSION_DENIED" || code === "WORKSPACE_ACCESS_DENIED")
    return "permission" as const;
  if (
    code === "STORAGE_CORRUPTED" ||
    code === "STORAGE_VERSION_UNSUPPORTED" ||
    code === "PROTOCOL_VERSION_UNSUPPORTED"
  )
    return "protocol" as const;
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
  if (code === "INTERRUPTED") return "interrupted" as const;
  if (
    code === "DEPENDENCY_UNAVAILABLE" ||
    code === "RUNTIME_UNAVAILABLE" ||
    code === "KEYCHAIN_UNAVAILABLE" ||
    code === "SECRET_MIGRATION_REQUIRED" ||
    code === "SECRET_STORE_LOCKED"
  )
    return "dependency" as const;
  return "execution" as const;
}

function doctorMessage(code: IntegrationErrorCode): string {
  if (code === "KEYCHAIN_UNAVAILABLE") return "The OS keychain is unavailable.";
  if (code === "SECRET_STORE_LOCKED") return "The OS keychain is locked or access was denied.";
  if (code === "SECRET_MIGRATION_REQUIRED") {
    return "Open the upgraded Desktop to migrate credentials.";
  }
  if (code === "PERMISSION_DENIED") return "Credential storage access was denied.";
  if (code === "STORAGE_CORRUPTED") return "Credential storage is corrupted.";
  if (code === "STORAGE_VERSION_UNSUPPORTED") return "Credential storage version is unsupported.";
  return "The command could not complete.";
}

function unavailableFindings(): readonly CredentialDoctorFinding[] {
  return ["model-provider", "capability", "plugin"].map((module) => ({
    module: module as CredentialDoctorFinding["module"],
    status: "degraded" as const,
    code: "KEYCHAIN_UNAVAILABLE" as const,
  }));
}

/** Test-only process composition for CLI executable integration tests. */
function testKeychainFromEnvironment(): OsKeychain | undefined {
  if (process.env["NODE_ENV"] !== "test") return undefined;
  const status = process.env["PRAGMA_CLI_TEST_KEYCHAIN_STATUS"];
  if (status !== "ready" && status !== "locked" && status !== "unavailable") return undefined;
  return {
    inspect: async () => ({
      status,
      backend: "macos-keychain" as const,
      reasonCode:
        status === "ready"
          ? undefined
          : status === "locked"
            ? "KEYCHAIN_ACCESS_DENIED"
            : "KEYCHAIN_BACKEND_UNAVAILABLE",
    }),
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
  };
}
