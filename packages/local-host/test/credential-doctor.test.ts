import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { integrationErrorExitCode } from "@pragma/shared/integration";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectCredentialMigration,
  type CredentialDoctorFinding,
} from "../src/secrets/credential-doctor.ts";
import { createSecretStore } from "../src/secrets/secret-store.ts";
import { modelProvidersV6ToV7Step } from "../src/model-providers/migrations/index.ts";
import type { SecretRef } from "@pragma/shared/integration";
import type { OsKeychain, SecretStore } from "../src/secrets/secret-store.ts";
import {
  MODEL_PROVIDER_STORAGE_VERSION,
  StoredModelProviderConfigSchema,
} from "../src/model-providers/reader.ts";
import {
  ModelProvidersV5Schema,
  ModelProvidersV6Schema,
} from "../src/model-providers/migrations/index.ts";
import {
  CapabilityCredentialsV2Schema,
  CapabilityCredentialsV3Schema,
  capabilityCredentialStorageVersions,
} from "../src/resources/capability-credential-migrations/index.ts";
import { pluginCredentialStorageVersions } from "../src/resources/plugin-credential-migrations/index.ts";

const currentDocuments = {
  "model-provider": StoredModelProviderConfigSchema.parse({
    schemaVersion: MODEL_PROVIDER_STORAGE_VERSION,
    providers: [],
  }),
  capability: CapabilityCredentialsV3Schema.parse({
    schemaVersion: capabilityCredentialStorageVersions.currentVersion,
    credentials: {},
  }),
  plugin: { schemaVersion: pluginCredentialStorageVersions.currentVersion, credentials: {} },
};

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
  it("accepts current storage schemas without a journal and leaves files unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-current-"));
    roots.push(root);
    const files = {
      "model-provider": join(root, "model.json"),
      capability: join(root, "capability.json"),
      plugin: join(root, "plugin.json"),
    };
    await Promise.all(
      Object.entries(files).map(([module, file]) =>
        writeFile(
          file,
          JSON.stringify(currentDocuments[module as CredentialDoctorFinding["module"]]),
        ),
      ),
    );
    const before = await Promise.all(Object.values(files).map((file) => readFile(file, "utf8")));

    expect(await inspectCredentialMigration({ secretStore: readySecretStore, files })).toEqual([
      { module: "model-provider", status: "ready" },
      { module: "capability", status: "ready" },
      { module: "plugin", status: "ready" },
    ]);
    expect(await Promise.all(Object.values(files).map((file) => readFile(file, "utf8")))).toEqual(
      before,
    );
  });

  it.each([
    ["model-provider", currentDocuments["model-provider"].schemaVersion + 1],
    ["capability", currentDocuments.capability.schemaVersion + 1],
    ["plugin", currentDocuments.plugin.schemaVersion + 1],
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

  it("reports supported metadata versions as ready and legacy credentials as migration-required", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-"));
    roots.push(root);
    const paths = {
      "model-provider": join(root, "model.json"),
      capability: join(root, "capability.json"),
      plugin: join(root, "plugin.json"),
    } as const;
    await Promise.all([
      writeFile(paths["model-provider"], JSON.stringify({ schemaVersion: 5, providers: [] })),
      writeFile(paths.capability, JSON.stringify({ schemaVersion: 1 })),
      writeFile(paths.plugin, JSON.stringify({ schemaVersion: 2, credentials: {} })),
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
    ["model-provider", currentDocuments["model-provider"]],
    ["capability", currentDocuments.capability],
    ["plugin", currentDocuments.plugin],
    ["model-provider", ModelProvidersV5Schema.parse({ schemaVersion: 5, providers: [] })],
    ["model-provider", ModelProvidersV6Schema.parse({ schemaVersion: 6, providers: [] })],
    ["capability", CapabilityCredentialsV2Schema.parse({ schemaVersion: 2, credentials: {} })],
  ] as const)(
    "treats a retained-backup journal for supported %s data as ready",
    async (module, document) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-terminal-"));
      roots.push(root);
      const file = join(root, `${module}.json`);
      await writeFile(file, JSON.stringify(document));
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
    await writeFile(file, JSON.stringify(currentDocuments["model-provider"]));
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

  it("warns about a missing historical backup without requiring migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-backup-"));
    roots.push(root);
    const file = join(root, "model-provider.json");
    await writeFile(file, JSON.stringify(currentDocuments["model-provider"]));
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
      status: "ready",
      warnings: [
        {
          code: "LEGACY_CREDENTIAL_BACKUP_MISSING",
          message: expect.stringContaining("reopening Desktop will not recreate it"),
        },
      ],
    });
  });

  it.each(["unexpected-path", "directory"] as const)(
    "rejects a %s backup instead of treating invalid recovery evidence as a missing-backup warning",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-doctor-backup-integrity-"));
      roots.push(root);
      const file = join(root, "model-provider.json");
      await writeFile(file, JSON.stringify(currentDocuments["model-provider"]));
      await writeMigrationJournal(file, "model-provider", "legacy_backup_retained");
      const journalFile = `${file}.migration-journal.json`;
      const journal = JSON.parse(await readFile(journalFile, "utf8")) as { backupPath: string };
      if (kind === "directory") {
        await rm(journal.backupPath);
        await mkdir(journal.backupPath);
      } else {
        await writeFile(
          journalFile,
          JSON.stringify({ ...journal, backupPath: join(root, "unrelated-backup.json") }),
        );
      }
      const findings = await inspectCredentialMigration({
        secretStore: readySecretStore,
        files: {
          "model-provider": file,
          capability: join(root, "missing-capability"),
          plugin: join(root, "missing-plugin"),
        },
      });
      expect(findings.find((finding) => finding.module === "model-provider")).toEqual({
        module: "model-provider",
        status: "degraded",
        code: "STORAGE_CORRUPTED",
      });
    },
  );

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
    await writeFile(file, JSON.stringify(currentDocuments["model-provider"]));
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
    await writeFile(file, JSON.stringify(currentDocuments["model-provider"]));
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

  it.each(["model-provider", "capability", "plugin"] as const)(
    "rejects inconsistent historical journal metadata for current %s data",
    async (module) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-metadata-"));
      roots.push(root);
      const file = join(root, `${module}.json`);
      await writeFile(file, JSON.stringify(currentDocuments[module]));
      const files = {
        "model-provider": join(root, "missing-model.json"),
        capability: join(root, "missing-capability.json"),
        plugin: join(root, "missing-plugin.json"),
        [module]: file,
      };
      for (const [options, code] of [
        [
          { sourceVersion: migrationDefinitions[module].sourceVersion + 1 },
          "SECRET_MIGRATION_REQUIRED",
        ],
        [
          { targetVersion: migrationDefinitions[module].targetVersion + 1 },
          "SECRET_MIGRATION_REQUIRED",
        ],
        [
          { targetMetadataVersion: migrationDefinitions[module].targetVersion + 1 },
          "STORAGE_CORRUPTED",
        ],
      ] as const) {
        await writeMigrationJournal(file, module, "legacy_backup_retained", options);
        expect(
          (await inspectCredentialMigration({ secretStore: readySecretStore, files })).find(
            (finding) => finding.module === module,
          ),
        ).toEqual({ module, status: "degraded", code });
      }
      await writeMigrationJournal(file, module, "prepared");
      expect(
        (await inspectCredentialMigration({ secretStore: readySecretStore, files })).find(
          (finding) => finding.module === module,
        ),
      ).toEqual({ module, status: "degraded", code: "SECRET_MIGRATION_REQUIRED" });
    },
  );

  it.each(["model-provider", "capability", "plugin"] as const)(
    "checks active %s secrets after migration, including rotation and credential failures",
    async (module) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-doctor-active-"));
      roots.push(root);
      const keys = new Map<string, Uint8Array>();
      const store = createSecretStore({
        root: join(root, "secrets"),
        keychain: {
          ...readyKeychain,
          get: async (_service, account) => keys.get(account) ?? null,
          set: async (_service, account, value) => {
            keys.set(account, value);
          },
        },
      });
      const providerId = "c47f532c-6c48-4dc3-917b-432728254b64";
      const owner =
        module === "model-provider"
          ? { kind: "model-provider" as const, providerId }
          : module === "capability"
            ? { kind: "capability" as const, capabilityId: "aaaaaaaaaaaaaaaa", name: "token" }
            : { kind: "plugin-binding" as const, bindingRef: "plugin/token" };
      const original = await store.put({ owner, value: Buffer.from("must-not-leak") });
      const file = join(root, `${module}.json`);
      const files = {
        "model-provider": join(root, "missing-model"),
        capability: join(root, "missing-capability"),
        plugin: join(root, "missing-plugin"),
        [module]: file,
      };
      const writeCurrent = async (ref: SecretRef) => {
        let document: unknown;
        if (module === "model-provider") {
          const historical = ModelProvidersV6Schema.parse(
            JSON.parse(
              await readFile(
                new URL(
                  "../../memory/test/fixtures/retrieval/model-providers-v6.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            ),
          );
          document = modelProvidersV6ToV7Step.migrate({
            ...historical,
            providers: historical.providers.map((provider) => ({
              ...provider,
              apiKeySecretRef: ref,
            })),
          });
        } else {
          document = {
            schemaVersion: currentDocuments[module].schemaVersion,
            credentials: {
              "aaaaaaaaaaaaaaaa/token":
                module === "capability" ? { generation: ref.revision, ref } : ref,
            },
          };
        }
        await writeFile(file, JSON.stringify(document));
      };
      await writeCurrent(original);
      await writeMigrationJournal(file, module, "legacy_backup_retained", { writeBackup: false });
      // A historical ref becomes stale after normal rotation. Doctor must use the live document.
      const journalFile = `${file}.migration-journal.json`;
      const journal = JSON.parse(await readFile(journalFile, "utf8"));
      await writeFile(
        journalFile,
        JSON.stringify({
          ...journal,
          refs: [{ key: "old", ref: original, digest: "a".repeat(64) }],
        }),
      );
      const rotated = await store.put({
        owner,
        value: Buffer.from("rotated-must-not-leak"),
        expectedRevision: original.revision,
      });
      await writeCurrent(rotated);
      const before = await readFile(file, "utf8");
      const inspect = async () =>
        (await inspectCredentialMigration({ secretStore: store, files })).find(
          (finding) => finding.module === module,
        )!;
      const finding = await inspect();
      expect(finding).toMatchObject({
        status: "ready",
        warnings: [{ code: "LEGACY_CREDENTIAL_BACKUP_MISSING" }],
      });
      expect(JSON.stringify(finding)).not.toContain("must-not-leak");
      expect(await readFile(file, "utf8")).toBe(before);

      await writeCurrent(original);
      expect(await inspect()).toMatchObject({
        status: "degraded",
        code: "STORAGE_CORRUPTED",
        reasonCode: "SECRET_REVISION_CONFLICT",
      });
      await expect(
        store.put({
          owner,
          value: Buffer.from("replacement"),
          expectedRevision: original.revision,
        }),
      ).rejects.toMatchObject({ code: "SECRET_REVISION_CONFLICT" });
      await writeCurrent(rotated);
      const savedKeys = new Map(keys);
      keys.clear();
      expect(await inspect()).toMatchObject({
        status: "degraded",
        code: "STORAGE_CORRUPTED",
        reasonCode: "SECRET_MASTER_KEY_MISSING",
      });
      await expect(
        store.put({ owner, value: Buffer.from("replacement"), expectedRevision: rotated.revision }),
      ).rejects.toMatchObject({ code: "SECRET_MASTER_KEY_MISSING" });
      for (const [account, key] of savedKeys) keys.set(account, key);
      const envelopePath = join(
        root,
        "secrets",
        "objects",
        Buffer.from(rotated.secretId).toString("base64url"),
        `${rotated.revision}.json`,
      );
      const envelope = await readFile(envelopePath, "utf8");
      await writeFile(envelopePath, "{broken-envelope");
      expect(await inspect()).toMatchObject({
        status: "degraded",
        reasonCode: "SECRET_STORE_CORRUPTED",
      });
      await writeFile(envelopePath, envelope);
      await store.delete(rotated, rotated.revision);
      expect(await inspect()).toMatchObject({ status: "degraded", reasonCode: "SECRET_NOT_FOUND" });
      await rm(journalFile);
      expect(await inspect()).toEqual({
        module,
        status: "degraded",
        code: "STORAGE_CORRUPTED",
        reasonCode: "SECRET_NOT_FOUND",
      });
    },
  );

  it("disposes validated secret handles without reading their values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-doctor-handle-"));
    roots.push(root);
    const file = join(root, "plugin.json");
    const ref = {
      schemaVersion: "pragma.secret-ref/v1",
      secretId: migrationDefinitions.plugin.id,
      revision: migrationDefinitions.plugin.id,
      owner: { kind: "plugin-binding", bindingRef: "token" },
    };
    await writeFile(file, JSON.stringify({ schemaVersion: 2, credentials: { token: ref } }));
    let disposed = false;
    const findings = await inspectCredentialMigration({
      secretStore: {
        ...readySecretStore,
        get: async () => ({
          bytes: () => {
            throw new Error("must not read");
          },
          utf8: () => {
            throw new Error("must not read");
          },
          dispose: () => {
            disposed = true;
          },
        }),
      },
      files: {
        "model-provider": join(root, "missing-model"),
        capability: join(root, "missing-capability"),
        plugin: file,
      },
    });
    expect(findings.find((finding) => finding.module === "plugin")).toEqual({
      module: "plugin",
      status: "ready",
    });
    expect(disposed).toBe(true);
  });
});

async function writeMigrationJournal(
  file: string,
  module: CredentialDoctorFinding["module"],
  stage: string,
  options: {
    readonly writeBackup?: boolean;
    readonly family?: string;
    readonly sourceVersion?: number;
    readonly targetVersion?: number;
    readonly targetMetadataVersion?: number;
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
      sourceVersion: options.sourceVersion ?? definition.sourceVersion,
      targetVersion: options.targetVersion ?? definition.targetVersion,
      stage,
      sourceHash: "a".repeat(64),
      targetMetadata: { schemaVersion: options.targetMetadataVersion ?? definition.targetVersion },
      refs: [],
      backupPath,
      decision: "legacy_ciphertext_removed_after_verified_secretstore_migration",
    }),
  );
}
