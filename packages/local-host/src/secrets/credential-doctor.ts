import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { PragmaPaths } from "@pragma/core";
import { SecretRefSchema, type IntegrationErrorCode } from "@pragma/shared/integration";
import { z } from "zod";

import { createNativeOsKeychain } from "./native-os-keychain.ts";
import type { SecretStore } from "./secret-store.ts";
import { createSecretStore, type OsKeychain } from "./secret-store.ts";

export type CredentialDoctorFinding = {
  readonly module: "model-provider" | "capability" | "plugin";
  readonly status: "ready" | "migration_required" | "degraded";
  readonly code?: IntegrationErrorCode | undefined;
};

const CredentialMigrationDefinitions = {
  "model-provider": {
    family: "pragma.model-providers",
    sourceVersion: 4,
    targetVersion: 5,
  },
  capability: {
    family: "pragma.capability-credentials",
    sourceVersion: 1,
    targetVersion: 2,
  },
  plugin: {
    family: "pragma.plugin-credentials",
    sourceVersion: 1,
    targetVersion: 2,
  },
} as const satisfies Record<
  CredentialDoctorFinding["module"],
  { readonly family: string; readonly sourceVersion: number; readonly targetVersion: number }
>;

/**
 * This is deliberately a local, metadata-only copy of the Desktop journal
 * contract. Local Host cannot depend on Desktop, and the doctor must validate
 * the journal without reading any legacy ciphertext or secret envelope.
 */
const CredentialMigrationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.legacy-credential-migration/v1"),
    family: z.string().min(1),
    id: z.string().uuid(),
    sourceVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive(),
    // Unknown but non-empty stages fail closed as migration-required below.
    stage: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetMetadata: z.unknown().optional(),
    refs: z.array(
      z
        .object({
          key: z.string().min(1),
          ref: SecretRefSchema,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    backupPath: z.string().min(1),
    decision: z.literal("legacy_ciphertext_removed_after_verified_secretstore_migration"),
  })
  .strict();

type CredentialMigrationJournal = z.infer<typeof CredentialMigrationJournalSchema>;

/** Metadata-only inspection suitable for a CLI doctor presenter. It never reads an envelope value. */
export async function inspectCredentialMigration(input: {
  readonly secretStore: SecretStore;
  readonly files: Readonly<Record<CredentialDoctorFinding["module"], string>>;
}): Promise<readonly CredentialDoctorFinding[]> {
  const health = await input.secretStore.inspect();
  const keychainCode =
    health.status === "locked"
      ? "SECRET_STORE_LOCKED"
      : health.status === "unavailable"
        ? "KEYCHAIN_UNAVAILABLE"
        : undefined;
  return await Promise.all(
    (Object.entries(input.files) as [CredentialDoctorFinding["module"], string][]).map(
      async ([module, file]) => {
        if (keychainCode !== undefined) return { module, status: "degraded", code: keychainCode };
        const definition = CredentialMigrationDefinitions[module];
        let journal: CredentialMigrationJournal | undefined;
        try {
          journal = await readMigrationJournal(`${file}.migration-journal.json`);
        } catch (error) {
          return {
            module,
            status: "degraded",
            code: doctorErrorCode(error),
          };
        }
        let version: number | undefined;
        try {
          version = await schemaVersion(file);
        } catch (error) {
          return { module, status: "degraded", code: doctorErrorCode(error) };
        }
        if (version === undefined)
          return journal === undefined
            ? { module, status: "ready" }
            : { module, status: "degraded", code: "SECRET_MIGRATION_REQUIRED" };
        const targetVersion = definition.targetVersion;
        if (version < targetVersion)
          return { module, status: "migration_required", code: "SECRET_MIGRATION_REQUIRED" };
        if (version > targetVersion)
          return { module, status: "degraded", code: "STORAGE_VERSION_UNSUPPORTED" };
        if (journal === undefined) return { module, status: "ready" };

        if (
          journal.family !== definition.family ||
          journal.sourceVersion !== definition.sourceVersion ||
          journal.targetVersion !== definition.targetVersion
        )
          return { module, status: "degraded", code: "SECRET_MIGRATION_REQUIRED" };

        if (journal.stage !== "legacy_backup_retained")
          return { module, status: "degraded", code: "SECRET_MIGRATION_REQUIRED" };

        if (!hasTargetSchema(journal.targetMetadata, targetVersion))
          return { module, status: "degraded", code: "STORAGE_CORRUPTED" };

        try {
          if (!(await hasRetainedBackup(file, journal)))
            return { module, status: "degraded", code: "SECRET_MIGRATION_REQUIRED" };
        } catch (error) {
          return { module, status: "degraded", code: doctorErrorCode(error) };
        }

        return { module, status: "ready" };
      },
    ),
  );
}

/**
 * Builds the metadata-only credential diagnostic used by Node Hosts. The caller
 * may inject a keychain for a test composition; production callers use the
 * native macOS/Windows backend and never receive a secret value.
 */
export async function inspectDefaultCredentialMigration(
  input: {
    readonly pragmaHome?: string | undefined;
    readonly keychain?: OsKeychain | undefined;
  } = {},
): Promise<readonly CredentialDoctorFinding[]> {
  const paths = new PragmaPaths({ pragmaHome: input.pragmaHome });
  return await inspectCredentialMigration({
    secretStore: createSecretStore({
      root: paths.secretStoreRoot(),
      dataRoot: paths.dataRoot(),
      keychain: input.keychain ?? createNativeOsKeychain(),
    }),
    files: {
      "model-provider": join(paths.dataRoot(), "model-providers.json"),
      capability: join(paths.credentialsRoot(), "capability-credentials.json"),
      plugin: join(paths.credentialsRoot(), "plugin-credentials.json"),
    },
  });
}

async function readMigrationJournal(path: string): Promise<CredentialMigrationJournal | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EPERM") throw new CredentialDoctorError("PERMISSION_DENIED");
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }

  if (isFutureMigrationJournal(value))
    throw new CredentialDoctorError("STORAGE_VERSION_UNSUPPORTED");
  try {
    return CredentialMigrationJournalSchema.parse(value);
  } catch {
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }
}

function isFutureMigrationJournal(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const schemaVersion = (value as { readonly schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion !== "string") return false;
  const match = /^pragma\.legacy-credential-migration\/v(\d+)$/.exec(schemaVersion);
  return match !== null && Number.parseInt(match[1]!, 10) > 1;
}

function hasTargetSchema(value: unknown, targetVersion: number): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly schemaVersion?: unknown }).schemaVersion === targetVersion
  );
}

async function hasRetainedBackup(
  file: string,
  journal: CredentialMigrationJournal,
): Promise<boolean> {
  const expectedPath = resolve(
    join(dirname(file), "migrations", "backups", `${journal.id}.legacy.json`),
  );
  const backupPath = resolve(journal.backupPath);
  if (backupPath !== expectedPath) return false;
  try {
    return (await stat(backupPath)).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") throw new CredentialDoctorError("PERMISSION_DENIED");
    return false;
  }
}

function doctorErrorCode(
  error: unknown,
): Extract<
  IntegrationErrorCode,
  | "PERMISSION_DENIED"
  | "SECRET_MIGRATION_REQUIRED"
  | "STORAGE_CORRUPTED"
  | "STORAGE_VERSION_UNSUPPORTED"
> {
  return error instanceof CredentialDoctorError ? error.code : "STORAGE_CORRUPTED";
}

class CredentialDoctorError extends Error {
  constructor(
    readonly code: Extract<
      IntegrationErrorCode,
      | "PERMISSION_DENIED"
      | "SECRET_MIGRATION_REQUIRED"
      | "STORAGE_CORRUPTED"
      | "STORAGE_VERSION_UNSUPPORTED"
    >,
  ) {
    super(code);
  }
}
async function schemaVersion(path: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EPERM") throw new CredentialDoctorError("PERMISSION_DENIED");
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger((value as { schemaVersion?: unknown }).schemaVersion)
  ) {
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }
  return (value as { schemaVersion: number }).schemaVersion;
}
