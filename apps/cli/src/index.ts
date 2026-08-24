import type {
  CredentialDoctorFinding,
  IntegrationErrorCode,
  LocalHostApplicationPort,
  OsKeychain,
} from "@pragma/local-host";
import { IntegrationErrorCodeSchema } from "@pragma/local-host/wire";

export const CLI_VERSION = "0.0.0";

export type CliIo = Readonly<{
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}>;

/** The future composition root injects this application port; CLI parsing never owns business logic. */
export type CliLocalHost = LocalHostApplicationPort;
export type CliDependencies = Readonly<{
  readonly inspectCredentialMigration?: () => Promise<readonly CredentialDoctorFinding[]>;
}>;

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    const [command] = argv;
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      io.writeStdout(
        "Usage: pragma <command>\n\nCommands:\n  version\n  doctor [--json]\n  help\n",
      );
      return 0;
    }
    if (command === "version") {
      io.writeStdout(`pragma ${CLI_VERSION}\n`);
      return 0;
    }
    if (command === "doctor") return await runDoctor(argv.slice(1), io, dependencies);
    io.writeStderr(`Unknown command: ${command}\nRun 'pragma --help' for usage.\n`);
    return 2;
  } catch {
    return writeInternalError(io);
  }
}

async function runDoctor(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const json = args.includes("--json");
  if (args.some((arg) => arg !== "--json")) {
    io.writeStderr("Usage: pragma doctor [--json]\n");
    return 2;
  }
  const startedAt = new Date();
  const wire = await import("@pragma/local-host/wire");
  let findings: readonly CredentialDoctorFinding[];
  try {
    if (dependencies.inspectCredentialMigration !== undefined) {
      findings = await dependencies.inspectCredentialMigration();
    } else {
      let host: typeof import("@pragma/local-host");
      try {
        host = await import("@pragma/local-host");
      } catch {
        const unavailable = unavailableFindings();
        return writeDoctorError(io, json, startedAt, wire, "KEYCHAIN_UNAVAILABLE", unavailable);
      }
      findings = await inspectCliCredentialMigration(host);
    }
  } catch (error) {
    return writeDoctorError(io, json, startedAt, wire, codeForError(error));
  }
  const code = selectPrimaryDoctorCode(findings);
  if (code !== undefined) return writeDoctorError(io, json, startedAt, wire, code, findings);
  return writeDoctorSuccess(io, json, startedAt, wire, findings);
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

function writeDoctorSuccess(
  io: CliIo,
  json: boolean,
  startedAt: Date,
  wire: typeof import("@pragma/local-host/wire"),
  findings: readonly CredentialDoctorFinding[],
): number {
  if (json) {
    io.writeStdout(
      `${JSON.stringify(cliResult(wire, "doctor", startedAt, { credentials: findings }))}\n`,
    );
  } else {
    io.writeStdout(renderFindings(findings));
  }
  return 0;
}

function writeDoctorError(
  io: CliIo,
  json: boolean,
  startedAt: Date,
  wire: typeof import("@pragma/local-host/wire"),
  code: IntegrationErrorCode,
  findings?: readonly CredentialDoctorFinding[],
): number {
  const error = wire.IntegrationErrorSchema.parse({
    schemaVersion: "pragma.integration-error/v1",
    code,
    message: doctorMessage(code),
    category: doctorCategory(code),
    retryable: code === "KEYCHAIN_UNAVAILABLE" || code === "SECRET_STORE_LOCKED",
  });
  if (json) {
    io.writeStdout(
      `${JSON.stringify(
        cliResult(wire, "doctor", startedAt, undefined, {
          ...error,
          ...(findings === undefined ? {} : { details: { credentials: findings } }),
        }),
      )}\n`,
    );
  } else {
    io.writeStdout(
      `${findings === undefined ? "" : renderFindings(findings)}${code}: ${error.message}\n`,
    );
  }
  return wire.integrationErrorExitCode(code);
}

function cliResult(
  wire: typeof import("@pragma/local-host/wire"),
  command: string,
  startedAt: Date,
  result?: unknown,
  error?: unknown,
) {
  const completedAt = new Date();
  return wire.CliResultSchema.parse({
    schemaVersion: "pragma.cli-result/v1",
    requestId: globalThis.crypto.randomUUID(),
    command,
    ok: error === undefined,
    ...(error === undefined ? { result } : { error }),
    warnings: [],
    meta: {
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      cliVersion: CLI_VERSION,
      protocolVersion: "pragma.integration/v1",
    },
  });
}

function renderFindings(findings: readonly CredentialDoctorFinding[]): string {
  if (findings.length === 0) return "Credential diagnostics: ready\n";
  return (
    findings
      .map(
        (finding) =>
          `${finding.module}: ${finding.status}${finding.code === undefined ? "" : ` (${finding.code})`}`,
      )
      .join("\n") + "\n"
  );
}
export function codeForError(error: unknown): IntegrationErrorCode {
  const code = (error as { code?: unknown }).code;
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
  "COMMAND_ACK_TIMEOUT",
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
function doctorCategory(code: IntegrationErrorCode) {
  return code === "PERMISSION_DENIED"
    ? ("permission" as const)
    : code === "STORAGE_CORRUPTED"
      ? ("protocol" as const)
      : code === "INTERNAL_ERROR"
        ? ("execution" as const)
        : ("dependency" as const);
}
function doctorMessage(code: IntegrationErrorCode): string {
  if (code === "KEYCHAIN_UNAVAILABLE") return "The OS keychain is unavailable.";
  if (code === "SECRET_STORE_LOCKED") return "The OS keychain is locked or access was denied.";
  if (code === "SECRET_MIGRATION_REQUIRED")
    return "Open the upgraded Desktop to migrate credentials.";
  if (code === "PERMISSION_DENIED") return "Credential storage access was denied.";
  if (code === "STORAGE_CORRUPTED") return "Credential storage is corrupted.";
  return "The command could not complete.";
}
function writeInternalError(io: CliIo): number {
  try {
    io.writeStderr("INTERNAL_ERROR: The command could not complete.\n");
  } catch {
    /* EPIPE and writer failures must not expose a stack. */
  }
  return 10;
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
