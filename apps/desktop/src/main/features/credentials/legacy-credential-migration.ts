import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  sameOwner,
  type LegacyCredentialDecryptor,
  type SecretOwner,
  type SecretRef,
  type SecretStore,
} from "@pragma/local-host";
import { SecretRefSchema } from "@pragma/shared/integration";
import { z } from "zod";

const JournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.legacy-credential-migration/v1"),
    family: z.string().min(1),
    id: z.string().uuid(),
    sourceVersion: z.number().int().positive(),
    targetVersion: z.number().int().positive(),
    stage: z.enum([
      "prepared",
      "targets_written",
      "target_metadata_written",
      "verified",
      "committed",
      "legacy_backup_retained",
      "needs_attention",
    ]),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetMetadata: z.unknown().optional(),
    refs: z.array(
      z.object({
        key: z.string().min(1),
        ref: SecretRefSchema,
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
    backupPath: z.string().min(1),
    decision: z.literal("legacy_ciphertext_removed_after_verified_secretstore_migration"),
  })
  .strict();

type Journal = z.infer<typeof JournalSchema>;

export type LegacySecretRecord = {
  readonly key: string;
  readonly owner: SecretOwner;
  readonly ciphertext: string;
};

export class LegacyCredentialMigrationError extends Error {
  constructor(
    readonly code:
      "SECRET_MIGRATION_REQUIRED" | "SECRET_MIGRATION_FAILED" | "SECRET_MIGRATION_FUTURE_VERSION",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyCredentialMigrationError";
  }
}

export async function migrateLegacyCredentialAggregate<TLegacy, TCurrent>(input: {
  readonly configPath: string;
  readonly family: string;
  readonly sourceVersion: number;
  readonly targetVersion: number;
  readonly secretStore: SecretStore;
  readonly decryptor?: LegacyCredentialDecryptor | undefined;
  readonly parseLegacy: (value: unknown) => TLegacy;
  readonly collect: (legacy: TLegacy) => readonly LegacySecretRecord[];
  readonly target: (legacy: TLegacy, refs: ReadonlyMap<string, SecretRef>) => TCurrent;
  readonly parseCurrent: (value: unknown) => TCurrent;
  readonly onStage?: ((stage: Journal["stage"]) => Promise<void> | void) | undefined;
}): Promise<{ readonly migrated: boolean; readonly value?: TCurrent | undefined }> {
  const journalPath = `${input.configPath}.migration-journal.json`;
  const lockPath = `${input.configPath}.lock`;
  return await withFileLock(
    lockPath,
    async () => {
      const current = await readJson(input.configPath);
      const pending = await readJournal(journalPath);
      if (pending !== undefined) {
        return await replay(input, pending, current, journalPath);
      }
      if (current === undefined) return { migrated: false };
      const version = schemaVersion(current);
      if (version > input.targetVersion) {
        throw new LegacyCredentialMigrationError(
          "SECRET_MIGRATION_FUTURE_VERSION",
          `${input.family} credential schema is newer than this Desktop supports.`,
        );
      }
      if (version === input.targetVersion)
        return { migrated: false, value: input.parseCurrent(current) };
      if (version !== input.sourceVersion) {
        throw new LegacyCredentialMigrationError(
          "SECRET_MIGRATION_REQUIRED",
          `${input.family} credentials require a supported Desktop migration.`,
        );
      }
      if (input.decryptor?.isAvailable() !== true) {
        throw new LegacyCredentialMigrationError(
          "SECRET_MIGRATION_REQUIRED",
          "Open the upgraded Desktop to migrate legacy credentials.",
        );
      }
      const legacy = input.parseLegacy(current);
      const id = randomUUID();
      const journal: Journal = {
        schemaVersion: "pragma.legacy-credential-migration/v1",
        family: input.family,
        id,
        sourceVersion: input.sourceVersion,
        targetVersion: input.targetVersion,
        stage: "prepared",
        sourceHash: hashJson(current),
        refs: [],
        backupPath: join(dirname(input.configPath), "migrations", "backups", `${id}.legacy.json`),
        decision: "legacy_ciphertext_removed_after_verified_secretstore_migration",
      };
      await writeJson(journal.backupPath, current);
      await writeJson(journalPath, journal);
      await input.onStage?.("prepared");
      return await replay(input, journal, current, journalPath, legacy);
    },
    { operation: `${input.family}.secret-migration` },
  );
}

async function replay<TLegacy, TCurrent>(
  input: Parameters<typeof migrateLegacyCredentialAggregate<TLegacy, TCurrent>>[0],
  journal: Journal,
  source: unknown | undefined,
  journalPath: string,
  knownLegacy?: TLegacy,
): Promise<{ readonly migrated: boolean; readonly value?: TCurrent | undefined }> {
  if (journal.family !== input.family || journal.targetVersion !== input.targetVersion) {
    throw new LegacyCredentialMigrationError(
      "SECRET_MIGRATION_FAILED",
      "Credential migration journal belongs to another schema family.",
    );
  }
  if (journal.stage === "needs_attention") {
    throw new LegacyCredentialMigrationError(
      "SECRET_MIGRATION_FAILED",
      "Credential migration needs attention; legacy data and recovery evidence were preserved.",
    );
  }
  let legacy = knownLegacy;
  if (
    legacy === undefined &&
    source !== undefined &&
    schemaVersion(source) === input.sourceVersion
  ) {
    legacy = input.parseLegacy(source);
    if (hashJson(source) !== journal.sourceHash) {
      throw new LegacyCredentialMigrationError(
        "SECRET_MIGRATION_FAILED",
        "Legacy credentials changed while migration was pending.",
      );
    }
  }
  if (journal.stage === "prepared" || journal.stage === "targets_written") {
    if (legacy === undefined || input.decryptor?.isAvailable() !== true) {
      throw new LegacyCredentialMigrationError(
        "SECRET_MIGRATION_REQUIRED",
        "Open the upgraded Desktop to finish credential migration.",
      );
    }
    const refs = new Map(journal.refs.map((entry) => [entry.key, entry.ref as SecretRef]));
    const digests = new Map(journal.refs.map((entry) => [entry.key, entry.digest]));
    for (const record of input.collect(legacy)) {
      let ref = refs.get(record.key);
      const plain = input.decryptor.decrypt(Buffer.from(record.ciphertext, "base64"));
      const digest = sha256(plain);
      try {
        if (ref === undefined) {
          const existing = (await input.secretStore.listMetadata(record.owner)).find((candidate) =>
            sameOwner(candidate.owner, record.owner),
          );
          ref = existing ?? (await input.secretStore.put({ owner: record.owner, value: plain }));
        }
        refs.set(record.key, ref);
        digests.set(record.key, digest);
      } finally {
        plain.fill(0);
      }
    }
    journal = {
      ...journal,
      stage: "targets_written",
      refs: [...refs].map(([key, ref]) => ({ key, ref, digest: digests.get(key)! })),
    };
    await writeJson(journalPath, journal);
    await input.onStage?.("targets_written");
    const metadata = input.target(legacy, refs);
    journal = { ...journal, stage: "target_metadata_written", targetMetadata: metadata };
    await writeJson(journalPath, journal);
    await input.onStage?.("target_metadata_written");
  }
  if (journal.targetMetadata === undefined) {
    throw new LegacyCredentialMigrationError(
      "SECRET_MIGRATION_FAILED",
      "Credential migration journal has no target metadata.",
    );
  }
  const verified = await verifyRefs(input.secretStore, journal.refs);
  if (!verified) {
    journal = { ...journal, stage: "needs_attention" };
    await writeJson(journalPath, journal);
    await input.onStage?.("needs_attention");
    throw new LegacyCredentialMigrationError(
      "SECRET_MIGRATION_FAILED",
      "New secret envelope verification failed; legacy credentials were not changed.",
    );
  }
  if (journal.stage === "target_metadata_written") {
    journal = { ...journal, stage: "verified" };
    await writeJson(journalPath, journal);
    await input.onStage?.("verified");
  }
  if (journal.stage === "verified") {
    await writeJson(input.configPath, input.parseCurrent(journal.targetMetadata));
    journal = { ...journal, stage: "committed" };
    await writeJson(journalPath, journal);
    await input.onStage?.("committed");
  }
  if (journal.stage === "committed") {
    journal = { ...journal, stage: "legacy_backup_retained" };
    await writeJson(journalPath, journal);
    await input.onStage?.("legacy_backup_retained");
  }
  return { migrated: true, value: input.parseCurrent(journal.targetMetadata) };
}

async function verifyRefs(
  store: SecretStore,
  refs: readonly Journal["refs"][number][],
): Promise<boolean> {
  for (const entry of refs) {
    try {
      const handle = await store.get(entry.ref as SecretRef);
      try {
        const expected = Buffer.from(entry.digest, "hex");
        const actual = Buffer.from(sha256(handle.bytes()), "hex");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
      } finally {
        handle.dispose();
      }
    } catch {
      return false;
    }
  }
  return true;
}

function schemaVersion(value: unknown): number {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger((value as { schemaVersion?: unknown }).schemaVersion)
  ) {
    throw new LegacyCredentialMigrationError(
      "SECRET_MIGRATION_REQUIRED",
      "Credential schema version is invalid.",
    );
  }
  return (value as { schemaVersion: number }).schemaVersion;
}
function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function readJournal(path: string): Promise<Journal | undefined> {
  let value: unknown;
  try {
    value = await readJson(path);
  } catch (error) {
    throw new LegacyCredentialMigrationError(
      "SECRET_MIGRATION_REQUIRED",
      "Credential migration journal is unreadable; recovery evidence was preserved.",
      { cause: error },
    );
  }
  if (value === undefined) return undefined;
  try {
    return JournalSchema.parse(value);
  } catch (error) {
    throw new LegacyCredentialMigrationError(
      "SECRET_MIGRATION_REQUIRED",
      "Credential migration journal is invalid; recovery evidence was preserved.",
      { cause: error },
    );
  }
}
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => undefined);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}
