import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { integrationErrorExitCode } from "@pragma/shared/integration";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectCredentialMigration,
  type CredentialDoctorFinding,
  type OsKeychain,
  type SecretStore,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const readyKeychain: OsKeychain = {
  inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined,
};

const migrationDefinitions = {
  "model-provider": {
    family: "pragma.model-providers",
    sourceVersion: 4,
    targetVersion: 5,
    id: "31a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
  },
  capability: {
    family: "pragma.capability-credentials",
    sourceVersion: 1,
    targetVersion: 2,
    id: "41a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
  },
  plugin: {
    family: "pragma.plugin-credentials",
    sourceVersion: 1,
    targetVersion: 2,
    id: "51a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
  },
} as const;

const readySecretStore: SecretStore = {
  inspect: readyKeychain.inspect,
  get: async () => {
    throw new Error("not used");
  },
  put: async () => {
    throw new Error("not used");
  },
  delete: async () => {
    throw new Error("not used");
  },
  listMetadata: async () => [],
};

describe("credential doctor schema versions", () => {
  it.each([
    ["model-provider", 6],
    ["capability", 3],
    ["plugin", 3],
  ] as const)(
    "reports future %s files as degraded storage incompatibility",
    async (module, version) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-"));
      roots.push(root);
      const file = join(root, `${module}.json`);
      await mkdir(root, { recursive: true });
      await writeFile(file, JSON.stringify({ schemaVersion: version }));
      const findings = await inspectCredentialMigration({
        secretStore: {
          inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
          get: async () => {
            throw new Error("not used");
          },
          put: async () => {
            throw new Error("not used");
          },
          delete: async () => {
            throw new Error("not used");
          },
          listMetadata: async () => [],
        },
        files: { "model-provider": file, capability: file, plugin: file },
      });
      const finding = findings.find((entry) => entry.module === module)!;
      expect(finding).toMatchObject({ status: "degraded", code: "STORAGE_VERSION_UNSUPPORTED" });
      expect(integrationErrorExitCode(finding.code!)).toBe(7);
    },
  );

  it("reports only the target version as ready and older versions as migration-required", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-"));
    roots.push(root);
    const paths = {
      "model-provider": join(root, "model.json"),
      capability: join(root, "capability.json"),
      plugin: join(root, "plugin.json"),
    } as const;
    await Promise.all([
      writeFile(paths["model-provider"], JSON.stringify({ schemaVersion: 5 })),
      writeFile(paths.capability, JSON.stringify({ schemaVersion: 1 })),
      writeFile(paths.plugin, JSON.stringify({ schemaVersion: 2 })),
    ]);
    const findings = await inspectCredentialMigration({
      secretStore: {
        inspect: readyKeychain.inspect,
        get: readyKeychain.get,
        put: readyKeychain.put,
        delete: readyKeychain.delete,
        listMetadata: async () => [],
      },
      files: paths,
    });
    expect(findings).toEqual([
      { module: "model-provider", status: "ready" },
      { module: "capability", status: "migration_required", code: "SECRET_MIGRATION_REQUIRED" },
      { module: "plugin", status: "ready" },
    ]);
  });

  it.each([
    ["model-provider", 5],
    ["capability", 2],
    ["plugin", 2],
  ] as const)(
    "treats a retained-backup journal for %s at its target schema as ready",
    async (module, targetVersion) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-terminal-"));
      roots.push(root);
      const file = join(root, `${module}.json`);
      await writeFile(file, JSON.stringify({ schemaVersion: targetVersion }));
      await writeMigrationJournal(file, module, "legacy_backup_retained");

      const findings = await inspectCredentialMigration({
        secretStore: readySecretStore,
        files: { "model-provider": file, capability: file, plugin: file },
      });

      expect(findings.find((finding) => finding.module === module)).toEqual({
        module,
        status: "ready",
      });
    },
  );

  it.each([
    "prepared",
    "targets_written",
    "target_metadata_written",
    "verified",
    "committed",
    "needs_attention",
    "in_progress",
    "failed",
  ] as const)("keeps non-terminal journal stage %s fail-closed", async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-pending-"));
    roots.push(root);
    const file = join(root, "model-provider.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 5 }));
    await writeMigrationJournal(file, "model-provider", stage);

    const findings = await inspectCredentialMigration({
      secretStore: readySecretStore,
      files: {
        "model-provider": file,
        capability: join(root, "missing-capability.json"),
        plugin: join(root, "missing-plugin.json"),
      },
    });

    expect(findings.find((finding) => finding.module === "model-provider")).toEqual({
      module: "model-provider",
      status: "degraded",
      code: "SECRET_MIGRATION_REQUIRED",
    });
  });

  it("does not report a terminal journal ready when its retained backup is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-backup-"));
    roots.push(root);
    const file = join(root, "model-provider.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 5 }));
    await writeMigrationJournal(file, "model-provider", "legacy_backup_retained", {
      writeBackup: false,
    });

    const findings = await inspectCredentialMigration({
      secretStore: readySecretStore,
      files: {
        "model-provider": file,
        capability: join(root, "missing-capability.json"),
        plugin: join(root, "missing-plugin.json"),
      },
    });

    expect(findings.find((finding) => finding.module === "model-provider")).toEqual({
      module: "model-provider",
      status: "degraded",
      code: "SECRET_MIGRATION_REQUIRED",
    });
  });

  it.each([
    ["malformed JSON", "{not-json", "STORAGE_CORRUPTED"],
    [
      "future journal version",
      JSON.stringify({ schemaVersion: "pragma.legacy-credential-migration/v2" }),
      "STORAGE_VERSION_UNSUPPORTED",
    ],
  ] as const)("fails closed for %s", async (_description, content, code) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-invalid-"));
    roots.push(root);
    const file = join(root, "model-provider.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 5 }));
    await writeFile(`${file}.migration-journal.json`, content);

    const findings = await inspectCredentialMigration({
      secretStore: readySecretStore,
      files: {
        "model-provider": file,
        capability: join(root, "missing-capability.json"),
        plugin: join(root, "missing-plugin.json"),
      },
    });

    expect(findings.find((finding) => finding.module === "model-provider")).toEqual({
      module: "model-provider",
      status: "degraded",
      code,
    });
  });

  it("rejects a terminal journal whose family does not match the inspected aggregate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-mismatch-"));
    roots.push(root);
    const file = join(root, "model-provider.json");
    await writeFile(file, JSON.stringify({ schemaVersion: 5 }));
    await writeMigrationJournal(file, "model-provider", "legacy_backup_retained", {
      family: "pragma.plugin-credentials",
    });

    const findings = await inspectCredentialMigration({
      secretStore: readySecretStore,
      files: {
        "model-provider": file,
        capability: join(root, "missing-capability.json"),
        plugin: join(root, "missing-plugin.json"),
      },
    });

    expect(findings.find((finding) => finding.module === "model-provider")).toEqual({
      module: "model-provider",
      status: "degraded",
      code: "SECRET_MIGRATION_REQUIRED",
    });
  });
});

async function writeMigrationJournal(
  file: string,
  module: CredentialDoctorFinding["module"],
  stage: string,
  options: {
    readonly writeBackup?: boolean;
    readonly family?: string;
  } = {},
): Promise<void> {
  const definition = migrationDefinitions[module];
  const backupPath = join(dirname(file), "migrations", "backups", `${definition.id}.legacy.json`);
  if (options.writeBackup !== false) {
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, "legacy backup placeholder");
  }
  await writeFile(
    `${file}.migration-journal.json`,
    JSON.stringify({
      schemaVersion: "pragma.legacy-credential-migration/v1",
      family: options.family ?? definition.family,
      id: definition.id,
      sourceVersion: definition.sourceVersion,
      targetVersion: definition.targetVersion,
      stage,
      sourceHash: "a".repeat(64),
      targetMetadata: { schemaVersion: definition.targetVersion },
      refs: [],
      backupPath,
      decision: "legacy_ciphertext_removed_after_verified_secretstore_migration",
    }),
  );
}
