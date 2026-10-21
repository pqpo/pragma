import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_PROVIDER_STORAGE_VERSION,
  ModelProvidersV5Schema,
  ModelProvidersV6Schema,
  modelProvidersV6ToV7Step,
  StoredModelProviderConfigSchema,
} from "@pragma/local-host";
import {
  CapabilityCredentialsV3Schema,
  CapabilityCredentialsV2Schema,
  capabilityCredentialStorageVersions,
  pluginCredentialStorageVersions,
} from "@pragma/local-host/resources";

const roots: string[] = [];

afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    ),
);

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
    ["current storage", false, false],
    ["current storage with historical journals", true, false],
    ["compatible legacy metadata with historical journals", true, true],
  ] as const)(
    "reports %s as ready without rewriting data or journals",
    async (_description, withJournals, withLegacyMetadata) => {
      const home = await currentHome(withJournals, withLegacyMetadata);
      const paths = credentialFiles(home);
      const inspectedPaths = Object.values(paths).flatMap((file) =>
        withJournals ? [file, `${file}.migration-journal.json`] : [file],
      );
      const before = await Promise.all(inspectedPaths.map((file) => readFile(file, "utf8")));
      const result = await invokeDoctor(home);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^CLI: .+ \(standalone\)\nExecutable: /u);
      expect(result.stdout).toContain("Terminal integration:");
      expect(result.stdout).toContain("Pragma commands on PATH:");
      expect(
        result.stdout.endsWith("model-provider: ready\ncapability: ready\nplugin: ready\n"),
      ).toBe(true);
      expect(await Promise.all(inspectedPaths.map((file) => readFile(file, "utf8")))).toEqual(
        before,
      );
    },
  );

  it.each(["model-provider", "capability", "plugin"] as const)(
    "rejects a future %s storage version with exit code 7",
    async (module) => {
      const home = await currentHome(false);
      const file = credentialFiles(home)[module];
      const value = JSON.parse(await readFile(file, "utf8")) as { schemaVersion: number };
      await writeFile(file, JSON.stringify({ ...value, schemaVersion: value.schemaVersion + 1 }));
      const result = await invokeDoctor(home);
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain(`${module}: degraded (STORAGE_VERSION_UNSUPPORTED)`);
      expect(result.stderr).toBe("");
    },
  );

  it.each(["text", "json"] as const)(
    "warns about a lost completed backup in %s output with success exit status",
    async (format) => {
      const home = await currentHome(true);
      const file = credentialFiles(home)["model-provider"];
      const journalFile = `${file}.migration-journal.json`;
      const before = await readFile(journalFile, "utf8");
      const journal = JSON.parse(before) as { backupPath: string };
      await rm(journal.backupPath);
      const result = await invoke(
        process.execPath,
        ["apps/cli/dist/pragma.js", "doctor", `--format=${format}`],
        {
          NODE_ENV: "test",
          NODE_NO_WARNINGS: "1",
          PRAGMA_HOME: home,
          PRAGMA_CLI_TEST_KEYCHAIN_STATUS: "ready",
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LEGACY_CREDENTIAL_BACKUP_MISSING");
      expect(result.stdout).not.toContain("SECRET_MIGRATION_REQUIRED");
      expect(result.stdout).not.toContain(journal.backupPath);
      expect(result.stderr).toBe("");
      if (format === "json")
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: "succeeded",
          result: {
            credentials: expect.arrayContaining([
              expect.objectContaining({
                module: "model-provider",
                status: "ready",
                warnings: [
                  { code: "LEGACY_CREDENTIAL_BACKUP_MISSING", message: expect.any(String) },
                ],
              }),
            ]),
          },
        });
      else expect(result.stdout).toContain("reopening Desktop will not recreate it");
      expect(await readFile(journalFile, "utf8")).toBe(before);
    },
  );

  it.each(["text", "json"] as const)(
    "reports an actual credential failure with a lost backup in %s output",
    async (format) => {
      const home = await currentHome(true);
      const file = credentialFiles(home)["model-provider"];
      const historical = ModelProvidersV6Schema.parse(
        JSON.parse(
          await readFile(
            new URL(
              "../../../packages/memory/test/fixtures/retrieval/model-providers-v6.json",
              import.meta.url,
            ),
            "utf8",
          ),
        ),
      );
      await writeFile(file, JSON.stringify(modelProvidersV6ToV7Step.migrate(historical)));
      const journal = JSON.parse(await readFile(`${file}.migration-journal.json`, "utf8")) as {
        backupPath: string;
      };
      await rm(journal.backupPath);
      const result = await invoke(
        process.execPath,
        ["apps/cli/dist/pragma.js", "doctor", `--format=${format}`],
        {
          NODE_ENV: "test",
          NODE_NO_WARNINGS: "1",
          PRAGMA_HOME: home,
          PRAGMA_CLI_TEST_KEYCHAIN_STATUS: "ready",
        },
      );
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain("SECRET_MASTER_KEY_MISSING");
      expect(result.stdout).toContain("LEGACY_CREDENTIAL_BACKUP_MISSING");
      expect(result.stdout).toContain("Restore the original keychain key");
      expect(result.stdout).not.toContain("SECRET_MIGRATION_REQUIRED");
      expect(result.stdout).not.toContain("Open the upgraded Desktop");
      expect(result.stdout).not.toContain(journal.backupPath);
      expect(result.stderr).toBe("");
      if (format === "json")
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: "failed",
          error: {
            code: "STORAGE_CORRUPTED",
            details: {
              credentials: expect.arrayContaining([
                expect.objectContaining({
                  module: "model-provider",
                  status: "degraded",
                  reasonCode: "SECRET_MASTER_KEY_MISSING",
                }),
              ]),
            },
          },
        });
    },
  );

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

function credentialFiles(home: string) {
  return {
    "model-provider": join(home, "data", "model-providers.json"),
    capability: join(home, "data", "credentials", "capability-credentials.json"),
    plugin: join(home, "data", "credentials", "plugin-credentials.json"),
  };
}

async function currentHome(withJournals: boolean, withLegacyMetadata = false): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pragma-cli-doctor-completed-"));
  roots.push(home);
  const data = join(home, "data");
  const credentials = join(data, "credentials");
  await mkdir(credentials, { recursive: true });
  const providerPath = join(data, "model-providers.json");
  const capabilityPath = join(credentials, "capability-credentials.json");
  await writeFile(
    providerPath,
    JSON.stringify(
      withLegacyMetadata
        ? ModelProvidersV5Schema.parse({ schemaVersion: 5, providers: [] })
        : StoredModelProviderConfigSchema.parse({
            schemaVersion: MODEL_PROVIDER_STORAGE_VERSION,
            providers: [],
          }),
    ),
  );
  await writeFile(
    capabilityPath,
    JSON.stringify(
      withLegacyMetadata
        ? CapabilityCredentialsV2Schema.parse({ schemaVersion: 2, credentials: {} })
        : CapabilityCredentialsV3Schema.parse({
            schemaVersion: capabilityCredentialStorageVersions.currentVersion,
            credentials: {},
          }),
    ),
  );
  await writeFile(
    credentialFiles(home).plugin,
    JSON.stringify({
      schemaVersion: pluginCredentialStorageVersions.currentVersion,
      credentials: {},
    }),
  );
  if (!withJournals) return home;
  await writeCompletedJournal(providerPath, {
    family: "pragma.model-providers",
    sourceVersion: 4,
    targetVersion: 5,
    id: "31a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
  });
  await writeCompletedJournal(capabilityPath, {
    family: "pragma.capability-credentials",
    sourceVersion: 1,
    targetVersion: 2,
    id: "41a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
  });
  await writeCompletedJournal(credentialFiles(home).plugin, {
    family: "pragma.plugin-credentials",
    sourceVersion: 1,
    targetVersion: 2,
    id: "51a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
  });
  return home;
}

async function writeCompletedJournal(
  file: string,
  input: {
    readonly family: string;
    readonly sourceVersion: number;
    readonly targetVersion: number;
    readonly id: string;
  },
): Promise<void> {
  const backupPath = join(dirname(file), "migrations", "backups", `${input.id}.legacy.json`);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, "retained legacy backup");
  await writeFile(
    `${file}.migration-journal.json`,
    JSON.stringify({
      schemaVersion: "pragma.legacy-credential-migration/v1",
      ...input,
      stage: "legacy_backup_retained",
      sourceHash: "a".repeat(64),
      targetMetadata: { schemaVersion: input.targetVersion },
      refs: [],
      backupPath,
      decision: "legacy_ciphertext_removed_after_verified_secretstore_migration",
    }),
  );
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
