import { describe, expect, it, vi } from "vitest";

import type {
  LocalHostRunApplication,
  LocalHostRunApplicationOutcome,
  LocalHostRunRequest,
} from "@pragma/local-host";
import { CliEventV2StreamSchema, type WorkspaceSelection } from "@pragma/shared/integration";

import { codeForError, runCli, selectPrimaryDoctorCode, type CliLocalHost } from "../src/index.ts";
import { toIntegrationError } from "../src/commands/errors.ts";

function createIo() {
  return { writeStdout: vi.fn(), writeStderr: vi.fn() };
}

describe("runCli", () => {
  it("renders version without stderr output", async () => {
    const io = createIo();

    await expect(runCli(["version"], io)).resolves.toBe(0);
    expect(io.writeStdout).toHaveBeenCalledWith(expect.stringContaining("pragma 0.0.0"));
    expect(io.writeStderr).not.toHaveBeenCalled();
  });

  it("rejects unknown commands with the usage exit code", async () => {
    const io = createIo();

    await expect(runCli(["unknown"], io)).resolves.toBe(2);
    expect(io.writeStderr).toHaveBeenCalledWith(
      expect.stringContaining("Unknown command: unknown"),
    );
  });

  it("renders redacted doctor findings with a stable migration exit code", async () => {
    const io = createIo();

    await expect(
      runCli(["doctor"], io, {
        inspectCredentialMigration: async () => [
          {
            module: "model-provider",
            status: "migration_required",
            code: "SECRET_MIGRATION_REQUIRED",
          },
        ],
      }),
    ).resolves.toBe(5);
    expect(io.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("SECRET_MIGRATION_REQUIRED"),
    );
    expect(io.writeStderr).not.toHaveBeenCalled();
  });

  it("uses text by default and the shared CliResult envelope for --json", async () => {
    const textIo = createIo();
    await expect(
      runCli(["doctor"], textIo, {
        inspectCredentialMigration: async () => [{ module: "plugin", status: "ready" }],
      }),
    ).resolves.toBe(0);
    expect(textIo.writeStdout).toHaveBeenCalledWith("plugin: ready\n");

    const jsonIo = createIo();
    await expect(
      runCli(["doctor", "--json"], jsonIo, {
        inspectCredentialMigration: async () => [{ module: "plugin", status: "ready" }],
      }),
    ).resolves.toBe(0);
    const output = JSON.parse(jsonIo.writeStdout.mock.calls[0]![0] as string) as {
      schemaVersion: string;
      status: string;
      result: { credentials: unknown[] };
    };
    expect(output).toMatchObject({
      schemaVersion: "pragma.cli-result/v2",
      status: "succeeded",
      result: { credentials: [{ module: "plugin", status: "ready" }] },
    });
    expect(JSON.stringify(output)).not.toContain("pragma.cli.doctor/v1");
  });

  it("maps doctor failures to a registered exit code without throwing a raw stack", async () => {
    const io = createIo();
    await expect(
      runCli(["doctor"], io, {
        inspectCredentialMigration: async () => {
          throw new Error("secret=value");
        },
      }),
    ).resolves.toBe(10);
    expect(io.writeStdout).toHaveBeenCalledWith(expect.stringContaining("INTERNAL_ERROR"));
    expect(io.writeStdout).not.toHaveBeenCalledWith(expect.stringContaining("secret=value"));
  });

  it("selects the same primary failure regardless of finding order and preserves all findings in JSON", async () => {
    const findings = [
      {
        module: "plugin" as const,
        status: "degraded" as const,
        code: "SECRET_MIGRATION_REQUIRED" as const,
      },
      {
        module: "capability" as const,
        status: "degraded" as const,
        code: "PERMISSION_DENIED" as const,
      },
      {
        module: "model-provider" as const,
        status: "degraded" as const,
        code: "STORAGE_CORRUPTED" as const,
      },
    ];
    expect(selectPrimaryDoctorCode(findings)).toBe("STORAGE_CORRUPTED");
    expect(selectPrimaryDoctorCode([...findings].reverse())).toBe("STORAGE_CORRUPTED");

    const io = createIo();
    await expect(
      runCli(["doctor", "--json"], io, { inspectCredentialMigration: async () => findings }),
    ).resolves.toBe(7);
    const output = JSON.parse(io.writeStdout.mock.calls[0]![0] as string) as {
      error: { code: string; details: { credentials: unknown[] } };
    };
    expect(output.error.code).toBe("STORAGE_CORRUPTED");
    expect(output.error.details.credentials).toEqual(findings);
  });

  it("does not render a false ready line for an unexpected doctor error", async () => {
    const io = createIo();
    await expect(
      runCli(["doctor"], io, {
        inspectCredentialMigration: async () => {
          throw new Error("unexpected");
        },
      }),
    ).resolves.toBe(10);
    expect(io.writeStdout).toHaveBeenCalledWith(
      "INTERNAL_ERROR: The command could not complete.\n",
    );
  });

  it("uses the shared IntegrationError schema for valid new codes and rejects invalid ones", () => {
    expect(codeForError({ code: "STORAGE_VERSION_UNSUPPORTED" })).toBe(
      "STORAGE_VERSION_UNSUPPORTED",
    );
    expect(codeForError({ code: "NOT_A_REGISTERED_CODE" })).toBe("INTERNAL_ERROR");
  });

  it("keeps only safe messages from mapped plain-object errors", () => {
    expect(
      toIntegrationError({
        code: "mission_not_found",
        message: "Mission 123 not found.",
        details: { path: "/private/secret", token: "secret" },
        cause: "secret cause",
      }),
    ).toMatchObject({ code: "MISSION_NOT_FOUND", message: "Mission 123 not found." });
    expect(toIntegrationError({ code: "mission_not_found", message: "" }).message).toBe(
      "The command could not complete.",
    );
    expect(toIntegrationError({ code: "mission_not_found", message: 42 }).message).toBe(
      "The command could not complete.",
    );
    expect(toIntegrationError({ code: "INTERNAL_ERROR", message: "secret" })).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "The command could not complete.",
    });
    expect(
      toIntegrationError({
        code: "mission_not_found",
        message: "Mission 123 not found.",
        details: { path: "/private/secret" },
      }),
    ).not.toHaveProperty("details");
  });

  it("cancels the foreground owner on SIGINT and emits one interrupted JSONL end", async () => {
    const io = createIo();
    const workspace = createRunWorkspace();
    let signalHandler: (() => void) | undefined;
    let resolveOutcome!: (outcome: LocalHostRunApplicationOutcome) => void;
    let cancelled = false;
    const run: LocalHostRunApplication = {
      start: async (request: LocalHostRunRequest) => {
        const outcome = new Promise<LocalHostRunApplicationOutcome>((resolve) => {
          resolveOutcome = resolve;
        });
        const handle = {
          request,
          missionId: "11111111-1111-4111-8111-111111111111",
          payloadHash: `sha256:${"a".repeat(64)}`,
          disposition: "reserved" as const,
          executionId: "22222222-2222-4222-8222-222222222222",
          outcome,
          cancel: async () => {
            cancelled = true;
            resolveOutcome({
              status: "interrupted",
              missionId: "11111111-1111-4111-8111-111111111111",
              executionId: "22222222-2222-4222-8222-222222222222",
              executor: request.executor,
              workspace: request.workspace,
            });
          },
        };
        setTimeout(() => signalHandler?.(), 0);
        return handle;
      },
      startAttached: async (input, options) => await run.start(input.request, options),
      respond: async () => undefined,
    };
    const localHost = {
      resolveWorkspace: async () => workspace,
      run,
    } as unknown as CliLocalHost;

    const exitCode = await runCli(
      [
        "expert",
        "run",
        "expert:aaaaaaaaaaaaaaaa",
        "--workspace",
        "/workspace",
        "--prompt",
        "hello",
        "--format=jsonl",
      ],
      io,
      {
        localHost,
        terminal: { isControllingTerminal: () => false, readLine: async () => "" },
        signals: {
          onInterrupt: (handler) => {
            signalHandler = handler;
            return () => {
              signalHandler = undefined;
            };
          },
        },
      },
    );

    expect(exitCode).toBe(130);
    expect(cancelled).toBe(true);
    const events = io.writeStdout.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(CliEventV2StreamSchema.parse(events)).toMatchObject([
      {
        type: "stream.end",
        data: { status: "interrupted", exitCode: 130 },
      },
    ]);
  });
});

function createRunWorkspace(): WorkspaceSelection {
  return {
    schemaVersion: "pragma.integration-workspace/v1",
    requestedPath: "/workspace",
    canonicalPath: "/workspace",
    displayName: "workspace",
    identityHash: `sha256:${"b".repeat(64)}`,
    access: { exists: true, readable: true, writable: true },
    source: "explicit",
  };
}
