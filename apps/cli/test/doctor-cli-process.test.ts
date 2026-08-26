import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    ),
);

beforeAll(async () => {
  const result = await invoke("pnpm", ["--filter", "@pragma/cli...", "build"], {});
  expect(result.exitCode).toBe(0);
}, 120_000);

describe("pragma doctor executable", () => {
  it("starts the built bin with ordinary Node for help and JSON version output", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-cli-help-"));
    roots.push(home);
    const environment = { PRAGMA_HOME: home, NODE_NO_WARNINGS: "1" };

    const help = await invoke(process.execPath, ["apps/cli/dist/pragma.js", "--help"], environment);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: pragma");
    expect(help.stderr).toBe("");

    const version = await invoke(
      process.execPath,
      ["apps/cli/dist/pragma.js", "version", "--format=json"],
      environment,
    );
    expect(version.exitCode).toBe(0);
    expect(JSON.parse(version.stdout)).toMatchObject({
      schemaVersion: "pragma.cli-result/v2",
      status: "succeeded",
    });
    expect(version.stderr).toBe("");
  });

  it.each([
    ["expert", "--input", "hello"],
    ["flow", "--input-json", '{"value":1}'],
  ] as const)(
    "reads production stdin for %s run before executor resolution",
    async (kind, option, input) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-cli-stdin-"));
      roots.push(home);
      const result = await invoke(
        process.execPath,
        [
          "apps/cli/dist/pragma.js",
          kind,
          "run",
          `${kind}:aaaaaaaaaaaaaaaa`,
          "--workspace",
          home,
          option,
          "-",
          "--format=json",
        ],
        { PRAGMA_HOME: home },
        input,
      );

      expect(result.exitCode).toBe(3);
      expect(result.stdout).not.toContain("No stdin reader is configured");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: "pragma.cli-result/v2",
        status: "failed",
        error: { code: "EXECUTOR_NOT_FOUND" },
      });
    },
  );

  it("returns migration_required without exposing legacy ciphertext", async () => {
    const home = await legacyHome();

    const result = await invokeDoctor(home);

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("SECRET_MIGRATION_REQUIRED");
    expect(result.stderr).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain("ciphertext-must-not-leak");
    expect(`${result.stdout}${result.stderr}`).not.toContain("home:");
  });

  it("returns migration_required for a real pending journal without exposing ciphertext or paths", async () => {
    const home = await journalPendingHome();
    const result = await invokeDoctor(home);

    expect(result.exitCode).toBe(5);
    expect(result.stdout).toContain("SECRET_MIGRATION_REQUIRED");
    expect(`${result.stdout}${result.stderr}`).not.toContain("journal-ciphertext-must-not-leak");
    expect(`${result.stdout}${result.stderr}`).not.toContain(home);
  });

  it.each([
    ["locked", 5, "SECRET_STORE_LOCKED"],
    ["unavailable", 5, "KEYCHAIN_UNAVAILABLE"],
  ] as const)("returns %s health with its stable exit code", async (status, exitCode, code) => {
    const home = await legacyHome();

    const result = await invokeDoctor(home, status);

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toContain(code);
    expect(result.stderr).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain("ciphertext-must-not-leak");
    expect(`${result.stdout}${result.stderr}`).not.toContain("home:");
  });
});

async function legacyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pragma-cli-doctor-"));
  roots.push(home);
  await mkdir(join(home, "data"), { recursive: true });
  await writeFile(
    join(home, "data", "model-providers.json"),
    JSON.stringify({
      schemaVersion: 4,
      providers: [],
      encryptedForTest: "ciphertext-must-not-leak",
    }),
  );
  return home;
}

async function journalPendingHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pragma-cli-doctor-journal-"));
  roots.push(home);
  const data = join(home, "data");
  await mkdir(data, { recursive: true });
  await writeFile(
    join(data, "model-providers.json"),
    JSON.stringify({ schemaVersion: 5, providers: [] }),
  );
  await writeFile(
    `${join(data, "model-providers.json")}.migration-journal.json`,
    JSON.stringify({
      schemaVersion: "pragma.legacy-credential-migration/v1",
      family: "pragma.model-providers",
      id: "31a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
      sourceVersion: 4,
      targetVersion: 5,
      stage: "prepared",
      sourceHash: "a".repeat(64),
      refs: [],
      backupPath: "journal-ciphertext-must-not-leak",
      decision: "legacy_ciphertext_removed_after_verified_secretstore_migration",
    }),
  );
  return home;
}

async function invokeDoctor(
  home: string,
  keychainStatus: "ready" | "locked" | "unavailable" = "ready",
) {
  return await invoke(process.execPath, ["apps/cli/dist/pragma.js", "doctor"], {
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
    PRAGMA_HOME: home,
    PRAGMA_CLI_TEST_KEYCHAIN_STATUS: keychainStatus,
  });
}

function workspaceRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

function invoke(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot(),
      env: { ...process.env, ...environment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    if (input !== undefined) child.stdin.end(input);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
