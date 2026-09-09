import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import {
  SecretStoreError,
  type LegacyCredentialDecryptor,
  type SecretRef,
  type SecretStore,
} from "@pragma/local-host";
import { SecretRefSchema } from "@pragma/shared/integration";
import { z } from "zod";

import {
  migrateLegacyCredentialAggregate,
  type LegacySecretRecord,
} from "../credentials/legacy-credential-migration.ts";
import {
  CapabilityCredentialsV1Schema,
  CapabilityCredentialsV2Schema,
  CapabilityCredentialsV3Schema,
  capabilityCredentialsV1ToV2Step,
  capabilityCredentialsV2ToV3Step,
} from "./migrations/index.ts";

interface LegacyStoredCredentialConfig {
  readonly schemaVersion: 1;
  readonly credentials: Readonly<Record<string, string>>;
}
interface StoredCredentialConfigV2 {
  readonly schemaVersion: 2;
  readonly credentials: Readonly<Record<string, SecretRef>>;
}
type StoredCredentialConfig = z.infer<typeof CapabilityCredentialsV3Schema>;

const CredentialMutationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.capability-credential-mutation/v1"),
    mutationId: z.string().uuid(),
    capabilityId: z.string().min(1),
    mode: z.enum(["standalone", "capability-mutation"]),
    stage: z.enum(["prepared", "secrets-written", "mapping-committed"]),
    entries: z.array(
      z
        .object({
          key: z.string().min(1),
          generation: z.string().uuid(),
          ownerName: z.string().min(1),
          previousRef: SecretRefSchema.optional(),
          nextRef: SecretRefSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();
type CredentialMutationJournal = z.infer<typeof CredentialMutationJournalSchema>;

const CredentialDeletionJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.capability-credential-deletion/v1"),
    capabilityId: z.string().min(1),
    refs: z.array(SecretRefSchema),
  })
  .strict();
type CredentialDeletionJournal = z.infer<typeof CredentialDeletionJournalSchema>;

const CredentialV2ToV3MigrationJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.capability-credentials-v2-to-v3/v1"),
    sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    target: CapabilityCredentialsV3Schema,
  })
  .strict();

export interface PreparedCapabilityCredentials {
  readonly mutationId: string;
  readonly capabilityId: string;
  readonly previousRefs: readonly SecretRef[];
  readonly nextRefs: readonly SecretRef[];
}

export interface CapabilityCredentialReader {
  get(capabilityId: string, name: string): Promise<string | undefined>;
}

export interface CapabilityCredentialStore extends CapabilityCredentialReader {
  setMany(capabilityId: string, credentials: Readonly<Record<string, string>>): Promise<void>;
  prepareMany(
    capabilityId: string,
    credentials: Readonly<Record<string, string>>,
  ): Promise<PreparedCapabilityCredentials | undefined>;
  activate(prepared: PreparedCapabilityCredentials): Promise<void>;
  finalize(prepared: PreparedCapabilityCredentials): Promise<void>;
  rollback(prepared: PreparedCapabilityCredentials): Promise<void>;
  pending(capabilityId: string): Promise<PreparedCapabilityCredentials | undefined>;
  overlay(
    capabilityId: string,
    credentials: Readonly<Record<string, string>>,
  ): CapabilityCredentialReader;
  removeCapability(capabilityId: string): Promise<void>;
  fingerprint(capabilityId: string): Promise<string>;
  migrateLegacy?(): Promise<boolean>;
}

export class CapabilityCredentialStoreError extends Error {
  constructor(
    readonly code:
      | "config_invalid"
      | "secret_unavailable"
      | "migration_required"
      | "mutation_pending"
      | "unsupported_version",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CapabilityCredentialStoreError";
  }
}

export function createCapabilityCredentialStore(options: {
  readonly configPath: string;
  readonly secretStore: SecretStore;
  readonly legacyDecryptor?: LegacyCredentialDecryptor | undefined;
  readonly onMutationStage?:
    ((stage: CredentialMutationJournal["stage"]) => Promise<void>) | undefined;
}): CapabilityCredentialStore {
  const lockPath = `${options.configPath}.lock`;
  const journalPath = (capabilityId: string) =>
    `${options.configPath}.mutations/${encodePragmaPathSegment(capabilityId)}.json`;
  const deletionJournalPath = (capabilityId: string) =>
    `${options.configPath}.deletions/${encodePragmaPathSegment(capabilityId)}.json`;
  const v2BackupPath = `${options.configPath}.v2.backup.json`;
  const v2MigrationJournalPath = `${options.configPath}.v2-to-v3.json`;
  const migrateLegacy = async (): Promise<boolean> => {
    const source = await readRaw();
    if (source === undefined || version(source) === 3) return false;
    if (version(source) > 3) {
      throw new CapabilityCredentialStoreError(
        "unsupported_version",
        `Capability credential schema version ${version(source)} is newer than this Desktop supports.`,
      );
    }
    if (version(source) === 2) {
      await ensureCurrent();
      return true;
    }
    const result = await migrateLegacyCredentialAggregate<
      LegacyStoredCredentialConfig,
      StoredCredentialConfigV2
    >({
      configPath: options.configPath,
      family: "pragma.capability-credentials",
      sourceVersion: capabilityCredentialsV1ToV2Step.fromVersion,
      targetVersion: capabilityCredentialsV1ToV2Step.toVersion,
      secretStore: options.secretStore,
      decryptor: options.legacyDecryptor,
      parseLegacy: parseLegacy,
      parseCurrent: parseV2,
      collect: (legacy) =>
        Object.entries(legacy.credentials).map(([key, ciphertext]) => {
          const [capabilityId, name] = splitKey(key);
          return {
            key,
            ciphertext,
            owner: { kind: "capability", capabilityId, name },
          } satisfies LegacySecretRecord;
        }),
      target: (legacy, refs) => ({
        schemaVersion: 2,
        credentials: Object.fromEntries(
          Object.keys(legacy.credentials).map((key) => [key, refs.get(key)!]),
        ),
      }),
    });
    await ensureCurrent();
    return result.migrated || version(source) === 2;
  };
  const readRaw = async (): Promise<unknown | undefined> => {
    try {
      return JSON.parse(await readFile(options.configPath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof CapabilityCredentialStoreError) throw error;
      throw new CapabilityCredentialStoreError(
        "config_invalid",
        "The capability credential store has an unsupported format.",
        { cause: error },
      );
    }
  };
  const writeConfig = async (config: StoredCredentialConfig): Promise<void> => {
    // The generic migration writer owns durable upgrades. Normal mutations use the
    // same aggregate lock and atomic replacement from the existing store contract.
    const { mkdir, chmod, rename, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.configPath), 0o700).catch(() => undefined);
    const temporary = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, options.configPath);
    await chmod(options.configPath, 0o600).catch(() => undefined);
  };
  const writeJournal = async (journal: CredentialMutationJournal): Promise<void> => {
    await writeJsonAtomic(
      journalPath(journal.capabilityId),
      CredentialMutationJournalSchema.parse(journal),
    );
  };
  const writeDeletionJournal = async (journal: CredentialDeletionJournal): Promise<void> => {
    await writeJsonAtomic(
      deletionJournalPath(journal.capabilityId),
      CredentialDeletionJournalSchema.parse(journal),
    );
  };
  const ensureCurrent = async (): Promise<void> => {
    const raw = await readRaw();
    if (raw === undefined) return;
    const sourceVersion = version(raw);
    if (sourceVersion > 3) {
      throw new CapabilityCredentialStoreError(
        "unsupported_version",
        `Capability credential schema version ${sourceVersion} is newer than this Desktop supports.`,
      );
    }
    if (sourceVersion === 3) {
      await rm(v2MigrationJournalPath, { force: true });
      return;
    }
    if (sourceVersion === 1) {
      if (options.legacyDecryptor === undefined)
        throw new CapabilityCredentialStoreError(
          "migration_required",
          "Open the upgraded Desktop to migrate capability credentials.",
        );
      await migrateLegacyCredentialAggregate<
        LegacyStoredCredentialConfig,
        StoredCredentialConfigV2
      >({
        configPath: options.configPath,
        family: "pragma.capability-credentials",
        sourceVersion: capabilityCredentialsV1ToV2Step.fromVersion,
        targetVersion: capabilityCredentialsV1ToV2Step.toVersion,
        secretStore: options.secretStore,
        decryptor: options.legacyDecryptor,
        parseLegacy,
        parseCurrent: parseV2,
        collect: (legacy) =>
          Object.entries(legacy.credentials).map(([key, ciphertext]) => {
            const [capabilityId, name] = splitKey(key);
            return { key, ciphertext, owner: { kind: "capability", capabilityId, name } };
          }),
        target: (legacy, refs) => ({
          schemaVersion: 2,
          credentials: Object.fromEntries(
            Object.keys(legacy.credentials).map((key) => [key, refs.get(key)!]),
          ),
        }),
      });
    }
    await withFileLock(
      lockPath,
      async () => {
        const source = await readRaw();
        if (source === undefined) return;
        if (version(source) === 3) {
          await rm(v2MigrationJournalPath, { force: true });
          return;
        }
        if (version(source) !== capabilityCredentialsV2ToV3Step.fromVersion) {
          throw new CapabilityCredentialStoreError(
            "unsupported_version",
            `Capability credential schema version ${version(source)} cannot be migrated.`,
          );
        }
        let migration;
        const sourceHash = hashValue(capabilityCredentialsV2ToV3Step.inputSchema.parse(source));
        try {
          migration = CredentialV2ToV3MigrationJournalSchema.parse(
            JSON.parse(await readFile(v2MigrationJournalPath, "utf8")) as unknown,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          migration = CredentialV2ToV3MigrationJournalSchema.parse({
            schemaVersion: "pragma.capability-credentials-v2-to-v3/v1",
            sourceHash,
            target: capabilityCredentialsV2ToV3Step.migrate(source),
          });
        }
        if (migration.sourceHash !== sourceHash) {
          throw new CapabilityCredentialStoreError(
            "config_invalid",
            "The capability credential migration journal does not match its source aggregate.",
          );
        }
        await writeJsonAtomic(
          v2BackupPath,
          capabilityCredentialsV2ToV3Step.inputSchema.parse(source),
        );
        await writeJsonAtomic(v2MigrationJournalPath, migration);
        await writeConfig(migration.target);
        await rm(v2MigrationJournalPath, { force: true });
      },
      { operation: "capability-credentials.migrate-v2-v3" },
    );
  };
  const readConfig = async (): Promise<StoredCredentialConfig> => {
    await ensureCurrent();
    const raw = await readRaw();
    return raw === undefined ? { schemaVersion: 3, credentials: {} } : parseCurrent(raw);
  };
  const deleteRef = async (ref: SecretRef | undefined): Promise<void> => {
    if (ref === undefined) return;
    try {
      await options.secretStore.delete(ref, ref.revision);
    } catch (error) {
      if (error instanceof SecretStoreError && error.code === "SECRET_NOT_FOUND") return;
      throw error;
    }
  };
  const readCredentialJournal = async (
    capabilityId: string,
  ): Promise<CredentialMutationJournal | undefined> => {
    let journal: CredentialMutationJournal;
    try {
      journal = CredentialMutationJournalSchema.parse(
        JSON.parse(await readFile(journalPath(capabilityId), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return journal;
  };
  const readDeletionJournal = async (
    capabilityId: string,
  ): Promise<CredentialDeletionJournal | undefined> => {
    try {
      return CredentialDeletionJournalSchema.parse(
        JSON.parse(await readFile(deletionJournalPath(capabilityId), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const recoverDeletionLocked = async (capabilityId: string): Promise<void> => {
    const journal = await readDeletionJournal(capabilityId);
    if (journal === undefined) return;
    const raw = await readRaw();
    const current =
      raw === undefined ? { schemaVersion: 3 as const, credentials: {} } : parseCurrent(raw);
    const credentials = Object.fromEntries(
      Object.entries(current.credentials).filter(([key]) => !key.startsWith(`${capabilityId}/`)),
    );
    if (Object.keys(credentials).length !== Object.keys(current.credentials).length) {
      await writeConfig({ schemaVersion: 3, credentials });
    }
    for (const ref of journal.refs) await deleteRef(ref);
    await rm(deletionJournalPath(capabilityId), { force: true });
  };
  const recoverDeletion = async (capabilityId: string): Promise<void> => {
    await ensureCurrent();
    await withFileLock(lockPath, async () => await recoverDeletionLocked(capabilityId), {
      operation: "capability-credentials.recover-deletion",
    });
  };
  const rollbackJournalLocked = async (journal: CredentialMutationJournal): Promise<void> => {
    const raw = await readRaw();
    const current =
      raw === undefined ? { schemaVersion: 3 as const, credentials: {} } : parseCurrent(raw);
    if (journal.stage === "mapping-committed") {
      const restored = { ...current.credentials };
      for (const entry of journal.entries) {
        if (entry.previousRef === undefined) delete restored[entry.key];
        else
          restored[entry.key] = {
            generation: entry.previousRef.revision,
            ref: entry.previousRef,
          };
      }
      await writeConfig({ schemaVersion: 3, credentials: restored });
    }
    for (const entry of journal.entries) {
      await deleteRef(entry.nextRef);
      for (const ref of await options.secretStore.listMetadata({
        kind: "capability",
        capabilityId: journal.capabilityId,
        name: entry.ownerName,
      })) {
        await deleteRef(ref);
      }
    }
    await rm(journalPath(journal.capabilityId), { force: true });
  };
  const finalizeJournalLocked = async (journal: CredentialMutationJournal): Promise<void> => {
    for (const entry of journal.entries) await deleteRef(entry.previousRef);
    await rm(journalPath(journal.capabilityId), { force: true });
  };
  const recoverCredentialMutation = async (capabilityId: string): Promise<void> => {
    await recoverDeletion(capabilityId);
    const pending = await readCredentialJournal(capabilityId);
    if (pending === undefined || pending.mode === "capability-mutation") return;
    await ensureCurrent();
    await withFileLock(
      lockPath,
      async () => {
        const journal = await readCredentialJournal(capabilityId);
        if (journal === undefined) return;
        if (journal.stage === "mapping-committed") await finalizeJournalLocked(journal);
        else await rollbackJournalLocked(journal);
      },
      { operation: "capability-credentials.recover" },
    );
  };
  const getCredential = async (capabilityId: string, name: string): Promise<string | undefined> => {
    await recoverCredentialMutation(capabilityId);
    const binding = (await readConfig()).credentials[`${capabilityId}/${name}`];
    if (binding === undefined) return undefined;
    try {
      const value = await options.secretStore.get(binding.ref);
      try {
        return value.utf8();
      } finally {
        value.dispose();
      }
    } catch (error) {
      if (
        error instanceof SecretStoreError &&
        (error.code === "SECRET_STORE_LOCKED" || error.code === "KEYCHAIN_UNAVAILABLE")
      )
        throw error;
      throw new CapabilityCredentialStoreError(
        "secret_unavailable",
        `The saved credential ${name} cannot be decrypted on this device.`,
        { cause: error },
      );
    }
  };
  const prepareMany = async (
    capabilityId: string,
    credentials: Readonly<Record<string, string>>,
    mode: CredentialMutationJournal["mode"],
  ): Promise<PreparedCapabilityCredentials | undefined> => {
    if (Object.keys(credentials).length === 0) return undefined;
    await ensureCurrent();
    return await withFileLock(
      lockPath,
      async () => {
        await recoverDeletionLocked(capabilityId);
        const pending = await readCredentialJournal(capabilityId);
        if (pending !== undefined) {
          if (pending.mode === "standalone") {
            if (pending.stage === "mapping-committed") await finalizeJournalLocked(pending);
            else await rollbackJournalLocked(pending);
          } else {
            throw new CapabilityCredentialStoreError(
              "mutation_pending",
              "A Capability credential mutation is awaiting recovery.",
            );
          }
        }
        const current = await readConfig();
        let journal = CredentialMutationJournalSchema.parse({
          schemaVersion: "pragma.capability-credential-mutation/v1",
          mutationId: randomUUID(),
          capabilityId,
          mode,
          stage: "prepared",
          entries: Object.keys(credentials).map((name) => {
            const key = `${capabilityId}/${name}`;
            const generation = randomUUID();
            return {
              key,
              generation,
              ownerName: `${name}@${generation}`,
              ...(current.credentials[key] === undefined
                ? {}
                : { previousRef: current.credentials[key]!.ref }),
            };
          }),
        });
        await writeJournal(journal);
        try {
          await options.onMutationStage?.("prepared");
          for (const entry of journal.entries) {
            const name = splitKey(entry.key)[1];
            const ref = await options.secretStore.put({
              owner: { kind: "capability", capabilityId, name: entry.ownerName },
              value: Buffer.from(credentials[name]!),
            });
            journal = CredentialMutationJournalSchema.parse({
              ...journal,
              entries: journal.entries.map((candidate) =>
                candidate.key === entry.key ? { ...candidate, nextRef: ref } : candidate,
              ),
            });
            await writeJournal(journal);
          }
          journal = CredentialMutationJournalSchema.parse({
            ...journal,
            stage: "secrets-written",
          });
          await writeJournal(journal);
          await options.onMutationStage?.("secrets-written");
          return {
            mutationId: journal.mutationId,
            capabilityId,
            previousRefs: journal.entries.flatMap((entry) =>
              entry.previousRef === undefined ? [] : [entry.previousRef],
            ),
            nextRefs: journal.entries.map((entry) => entry.nextRef!),
          };
        } catch (error) {
          await rollbackJournalLocked(journal);
          throw error;
        }
      },
      { operation: "capability-credentials.prepare" },
    );
  };
  const requireJournal = async (
    prepared: PreparedCapabilityCredentials,
  ): Promise<CredentialMutationJournal> => {
    const journal = await readCredentialJournal(prepared.capabilityId);
    if (journal === undefined || journal.mutationId !== prepared.mutationId) {
      throw new CapabilityCredentialStoreError(
        "mutation_pending",
        "The prepared Capability credential mutation is unavailable.",
      );
    }
    return journal;
  };
  const descriptor = (journal: CredentialMutationJournal): PreparedCapabilityCredentials => ({
    mutationId: journal.mutationId,
    capabilityId: journal.capabilityId,
    previousRefs: journal.entries.flatMap((entry) =>
      entry.previousRef === undefined ? [] : [entry.previousRef],
    ),
    nextRefs: journal.entries.flatMap((entry) =>
      entry.nextRef === undefined ? [] : [entry.nextRef],
    ),
  });
  const activate = async (prepared: PreparedCapabilityCredentials): Promise<void> => {
    await withFileLock(
      lockPath,
      async () => {
        const existing = await readCredentialJournal(prepared.capabilityId);
        if (existing === undefined) {
          const activeRevisions = new Set(
            Object.values((await readConfig()).credentials).map((binding) => binding.ref.revision),
          );
          if (prepared.nextRefs.every((ref) => activeRevisions.has(ref.revision))) return;
          throw new CapabilityCredentialStoreError(
            "mutation_pending",
            "The prepared Capability credential mutation is unavailable.",
          );
        }
        let journal = await requireJournal(prepared);
        if (journal.stage === "mapping-committed") return;
        const current = await readConfig();
        const next = { ...current.credentials };
        for (const entry of journal.entries) {
          const active = current.credentials[entry.key]?.ref;
          if (active?.revision !== entry.previousRef?.revision) {
            throw new CapabilityCredentialStoreError(
              "mutation_pending",
              "Capability credentials changed after the generation was prepared.",
            );
          }
          next[entry.key] = { generation: entry.generation, ref: entry.nextRef! };
        }
        await writeConfig({ schemaVersion: 3, credentials: next });
        journal = CredentialMutationJournalSchema.parse({
          ...journal,
          stage: "mapping-committed",
        });
        await writeJournal(journal);
        await options.onMutationStage?.("mapping-committed");
      },
      { operation: "capability-credentials.activate" },
    );
  };
  const finalize = async (prepared: PreparedCapabilityCredentials): Promise<void> => {
    await withFileLock(
      lockPath,
      async () => {
        const journal = await readCredentialJournal(prepared.capabilityId);
        if (journal === undefined) return;
        if (journal.mutationId !== prepared.mutationId)
          throw new CapabilityCredentialStoreError(
            "mutation_pending",
            "A different Capability credential mutation is pending.",
          );
        await finalizeJournalLocked(journal);
      },
      { operation: "capability-credentials.finalize" },
    );
  };
  const rollback = async (prepared: PreparedCapabilityCredentials): Promise<void> => {
    await withFileLock(
      lockPath,
      async () => {
        const journal = await readCredentialJournal(prepared.capabilityId);
        if (journal === undefined) return;
        if (journal.mutationId !== prepared.mutationId)
          throw new CapabilityCredentialStoreError(
            "mutation_pending",
            "A different Capability credential mutation is pending.",
          );
        await rollbackJournalLocked(journal);
      },
      { operation: "capability-credentials.rollback" },
    );
  };
  return {
    migrateLegacy,
    overlay(capabilityId, credentials) {
      return {
        get: async (requestedCapabilityId, name) =>
          requestedCapabilityId === capabilityId && Object.hasOwn(credentials, name)
            ? credentials[name]
            : await getCredential(requestedCapabilityId, name),
      };
    },
    async setMany(capabilityId, credentials) {
      const prepared = await prepareMany(capabilityId, credentials, "standalone");
      if (prepared === undefined) return;
      try {
        await activate(prepared);
        await finalize(prepared);
      } catch (error) {
        await recoverCredentialMutation(capabilityId).catch(() => undefined);
        throw error;
      }
    },
    async prepareMany(capabilityId, credentials) {
      return await prepareMany(capabilityId, credentials, "capability-mutation");
    },
    activate,
    finalize,
    rollback,
    async pending(capabilityId) {
      await recoverDeletion(capabilityId);
      const journal = await readCredentialJournal(capabilityId);
      return journal?.mode === "capability-mutation" ? descriptor(journal) : undefined;
    },
    async get(capabilityId, name) {
      return await getCredential(capabilityId, name);
    },
    async removeCapability(capabilityId) {
      await ensureCurrent();
      await withFileLock(
        lockPath,
        async () => {
          await recoverDeletionLocked(capabilityId);
          const pending = await readCredentialJournal(capabilityId);
          if (pending !== undefined) await rollbackJournalLocked(pending);
          const current = await readConfig();
          const removed = Object.entries(current.credentials).filter(([key]) =>
            key.startsWith(`${capabilityId}/`),
          );
          const deletion = CredentialDeletionJournalSchema.parse({
            schemaVersion: "pragma.capability-credential-deletion/v1",
            capabilityId,
            refs: removed.map(([, binding]) => binding.ref),
          });
          await writeDeletionJournal(deletion);
          await writeConfig({
            schemaVersion: 3,
            credentials: Object.fromEntries(
              Object.entries(current.credentials).filter(
                ([key]) => !key.startsWith(`${capabilityId}/`),
              ),
            ),
          });
          for (const [, binding] of removed) await deleteRef(binding.ref);
          await rm(deletionJournalPath(capabilityId), { force: true });
        },
        { operation: "capability-credentials.remove" },
      );
    },
    async fingerprint(capabilityId) {
      await recoverCredentialMutation(capabilityId);
      const values = Object.entries((await readConfig()).credentials)
        .filter(([key]) => key.startsWith(`${capabilityId}/`))
        .sort(([a], [b]) => a.localeCompare(b));
      return createHash("sha256").update(JSON.stringify(values)).digest("hex");
    },
  };
}

function version(value: unknown): number {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isInteger((value as { schemaVersion?: unknown }).schemaVersion)
  )
    throw new CapabilityCredentialStoreError(
      "config_invalid",
      "The capability credential store has an invalid schema version.",
    );
  return (value as { schemaVersion: number }).schemaVersion;
}
function parseLegacy(value: unknown): LegacyStoredCredentialConfig {
  return CapabilityCredentialsV1Schema.parse(value);
}
function parseCurrent(value: unknown): StoredCredentialConfig {
  return CapabilityCredentialsV3Schema.parse(value);
}
function parseV2(value: unknown): StoredCredentialConfigV2 {
  return CapabilityCredentialsV2Schema.parse(value);
}
function splitKey(key: string): [string, string] {
  const index = key.indexOf("/");
  if (index <= 0 || index === key.length - 1)
    throw new Error("Invalid legacy capability credential key.");
  return [key.slice(0, index), key.slice(index + 1)];
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const { mkdir, chmod, rename, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
