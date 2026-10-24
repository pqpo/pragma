import { AutomationBindingV2Schema, automationBindingV2ToV3Step } from "./migrations/index.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  applyAtomicStateMigration,
  PragmaPaths,
  recoverAtomicStateMigration,
  withFileLock,
  writeStateMigrationBackup,
  moveOwnedStorageToTrash,
} from "@pragma/core";
import { z } from "zod";

import {
  AutomationBindingSchema,
  AutomationRunRecordSchema,
  type AutomationBinding,
  type AutomationRunRecord,
} from "../../../shared/contracts/index.ts";
import { migrateLegacyPragmaResourceRef } from "@pragma/interpreter";

const QueuedAutomationEventSchema = z
  .object({
    eventId: z.string().min(1).max(500),
    scheduledFor: z.string().datetime(),
    missionId: z.string().uuid(),
    createdAt: z.string().datetime(),
  })
  .strict();

const AutomationStateSchema = z
  .object({
    schemaVersion: z.literal("pragma.automation-state/v1"),
    automationRef: z.string().min(1),
    generation: z.string().uuid(),
    nextRunAt: z.string().datetime().optional(),
    missionId: z.string().uuid().optional(),
    queue: z.array(QueuedAutomationEventSchema).max(1_000),
    runs: z.array(AutomationRunRecordSchema).max(100),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type QueuedAutomationEvent = z.infer<typeof QueuedAutomationEventSchema>;
export type AutomationState = z.infer<typeof AutomationStateSchema>;

export interface AutomationStore {
  getBinding(ref: string): Promise<AutomationBinding | undefined>;
  saveBinding(binding: AutomationBinding): Promise<AutomationBinding>;
  getState(ref: string, generation: string): Promise<AutomationState>;
  updateState(
    ref: string,
    generation: string,
    update: (state: AutomationState) => AutomationState,
  ): Promise<AutomationState>;
  remove(ref: string): Promise<void>;
  retireGeneration(ref: string, generation: string): Promise<boolean>;
}

export class AutomationGenerationChangedError extends Error {
  constructor(readonly automationRef: string) {
    super(`Automation binding generation changed: ${automationRef}.`);
    this.name = "AutomationGenerationChangedError";
  }
}

export function createAutomationStore(paths: PragmaPaths, projectId: string): AutomationStore {
  let migration: Promise<void> | undefined;
  const ensureMigrated = async (): Promise<void> => {
    migration ??= migrateAutomationStorageV1(paths, projectId).catch((error: unknown) => {
      migration = undefined;
      throw error;
    });
    await migration;
  };
  const readBinding = async (ref: string): Promise<AutomationBinding | undefined> => {
    await ensureMigrated();
    const path = paths.automationBinding(ref);
    return await withFileLock(`${path}.permission-migration.lock`, async () => {
      const resource = { family: "pragma.automation-binding", id: ref };
      const journalFile = `${path}.permission-migration.json`;
      const key = relative(paths.root, path);
      const assertOwner = (binding: { automationRef: string }) => {
        if (binding.automationRef !== ref)
          throw new Error(`Automation binding identity mismatch: ${ref}.`);
      };
      const persisted = await readOptional(path, z.unknown());
      if (persisted !== undefined) {
        const parsed =
          (persisted as { schemaVersion?: unknown } | null)?.schemaVersion ===
          "pragma.automation-binding/v2"
            ? AutomationBindingV2Schema.parse(persisted)
            : AutomationBindingSchema.parse(persisted);
        assertOwner(parsed);
      }
      const validateDocuments = (documents: Readonly<Record<string, unknown>>) => {
        if (Object.keys(documents).length !== 1 || !(key in documents))
          throw new Error("Invalid automation migration target.");
        assertOwner(AutomationBindingSchema.parse(documents[key]));
      };
      await recoverAtomicStateMigration({
        aggregateRoot: paths.root,
        journalFile,
        resource,
        validateDocuments,
      });
      const input = await readOptional(path, z.unknown());
      if (input === undefined) return undefined;
      if ((input as { schemaVersion?: unknown }).schemaVersion === "pragma.automation-binding/v2") {
        const target = automationBindingV2ToV3Step.migrate(input);
        const backup = `${path}.v2.backup.json`;
        await writeStateMigrationBackup(backup, await readFile(path, "utf8"));
        await applyAtomicStateMigration({
          aggregateRoot: paths.root,
          journalFile,
          resource,
          fromVersion: 2,
          toVersion: 3,
          documents: { [key]: target },
          validateDocuments,
        });
        return target;
      }
      const binding = AutomationBindingSchema.parse(input);
      assertOwner(binding);
      return binding;
    });
  };
  const readState = async (ref: string, generation: string): Promise<AutomationState> => {
    const existing = await readOptional(paths.automationState(ref), AutomationStateSchema);
    if (existing !== undefined && existing.generation === generation) return existing;
    return AutomationStateSchema.parse({
      schemaVersion: "pragma.automation-state/v1",
      automationRef: ref,
      generation,
      queue: [],
      runs: [],
      updatedAt: new Date().toISOString(),
    });
  };
  return {
    getBinding: readBinding,
    async saveBinding(binding) {
      await ensureMigrated();
      const parsed = AutomationBindingSchema.parse(binding);
      // Recover a pending upgrade before committing a new binding under the same lock.
      await readBinding(parsed.automationRef);
      const path = paths.automationBinding(parsed.automationRef);
      await withFileLock(`${path}.permission-migration.lock`, async () => {
        await writeJsonAtomic(path, parsed);
      });
      return parsed;
    },
    async getState(ref, generation) {
      return await withFileLock(
        paths.automationLock(ref),
        async () => await readState(ref, generation),
      );
    },
    async updateState(ref, generation, update) {
      return await withFileLock(paths.automationLock(ref), async () => {
        const binding = await readBinding(ref);
        if (binding?.generation !== generation) {
          throw new AutomationGenerationChangedError(ref);
        }
        const current = await readState(ref, generation);
        const next = AutomationStateSchema.parse({
          ...update(current),
          schemaVersion: "pragma.automation-state/v1",
          automationRef: ref,
          generation,
          updatedAt: new Date().toISOString(),
        });
        await writeJsonAtomic(paths.automationState(ref), next);
        return next;
      });
    },
    async retireGeneration(ref, generation) {
      await ensureMigrated();
      return await withFileLock(paths.automationLock(ref), async () => {
        const state = await readOptional(paths.automationState(ref), AutomationStateSchema);
        if (state?.generation !== generation) return false;
        // Keep the aggregate lock in place and retire only the frozen generation's payload.
        // A retry after the rename must never remove state accepted by the new generation.
        await moveOwnedStorageToTrash({
          paths,
          owner: { type: "automation-generation", id: ref },
          sources: [{ label: "state.json", path: paths.automationState(ref) }],
        });
        return true;
      });
    },
    async remove(ref) {
      await ensureMigrated();
      // Finish any prepared upgrade before deletion so replay cannot resurrect the binding.
      await readBinding(ref);
      const path = paths.automationBinding(ref);
      await withFileLock(`${path}.permission-migration.lock`, async () => {
        await rm(`${path}.permission-migration.json`, { force: true });
        await Promise.all([
          rm(path, { force: true }),
          rm(paths.automationStateRoot(ref), { recursive: true, force: true }),
        ]);
      });
    },
  };
}

export function createAutomationBinding(input: {
  readonly automationRef: string;
  readonly previous?: AutomationBinding | undefined;
  readonly rotateGeneration: boolean;
  readonly workspace: AutomationBinding["workspace"];
  readonly modelOverride?: AutomationBinding["modelOverride"] | undefined;
  readonly contextMounts?: AutomationBinding["contextMounts"] | undefined;
}): AutomationBinding {
  const now = new Date().toISOString();
  return AutomationBindingSchema.parse({
    schemaVersion: "pragma.automation-binding/v3",
    automationRef: input.automationRef,
    revision: (input.previous?.revision ?? 0) + 1,
    generation:
      input.previous === undefined || input.rotateGeneration
        ? randomUUID()
        : input.previous.generation,
    workspace: input.workspace,
    placement: "desktop",
    ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
    contextMounts: input.contextMounts ?? [],
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
  });
}

const AutomationBindingV1Schema = AutomationBindingV2Schema.extend({
  schemaVersion: z.literal("pragma.automation-binding/v1"),
  automationRef: z.string().regex(/^automation:[^@]+@[^@]+$/),
});

async function migrateAutomationStorageV1(paths: PragmaPaths, projectId: string): Promise<void> {
  const root = paths.automationBindingsRoot();
  const marker = `${root}/.v2-migrated`;
  const journal = join(paths.storageStateRoot(), "automation-binding-v1-to-v2.json");
  const migrationResource = { family: "pragma.automation-binding", id: projectId } as const;
  const validateDocuments = (documents: Readonly<Record<string, unknown>>): void =>
    validateAutomationMigrationDocuments(paths, documents);
  if (await pathExists(marker)) return;
  await withFileLock(`${root}/.v1-to-v2.lock`, async () => {
    if (await pathExists(marker)) return;
    const pending = await readOptional(
      journal,
      z.object({ documents: z.record(z.string(), z.unknown()) }).passthrough(),
    );
    if (pending !== undefined) {
      validateDocuments(pending.documents);
      for (const [path, target] of Object.entries(pending.documents)) {
        const existing = await readOptional(join(paths.root, path), z.unknown());
        if (existing !== undefined && !isDeepStrictEqual(existing, target)) {
          throw new Error(`Automation migration conflicts with existing data: ${path}`);
        }
      }
    }
    await recoverAtomicStateMigration({
      aggregateRoot: paths.root,
      journalFile: journal,
      resource: migrationResource,
      validateDocuments,
    });
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
      return [];
    });
    const documents: Record<string, unknown> = {};
    const legacyEntries: { readonly bindingPath: string; readonly stateRoot: string }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const legacyPath = `${root}/${entry.name}`;
      const raw = JSON.parse(await readFile(legacyPath, "utf8")) as unknown;
      const current = AutomationBindingSchema.safeParse(raw);
      if (current.success || AutomationBindingV2Schema.safeParse(raw).success) continue;
      const legacy = AutomationBindingV1Schema.parse(raw);
      const ref = migrateAutomationRef(legacy.automationRef, projectId);
      const migrated = AutomationBindingV2Schema.parse({
        ...legacy,
        schemaVersion: "pragma.automation-binding/v2",
        automationRef: ref,
      });
      documents[relative(paths.root, paths.automationBinding(ref))] = migrated;
      const legacyStateRoot = paths.automationStateRoot(legacy.automationRef);
      const state = await readOptional(
        paths.automationState(legacy.automationRef),
        AutomationStateSchema,
      );
      if (state !== undefined) {
        documents[relative(paths.root, paths.automationState(ref))] = AutomationStateSchema.parse({
          ...state,
          automationRef: ref,
        });
      }
      legacyEntries.push({ bindingPath: legacyPath, stateRoot: legacyStateRoot });
    }
    if (Object.keys(documents).length > 0) {
      await applyAtomicStateMigration({
        aggregateRoot: paths.root,
        journalFile: journal,
        resource: migrationResource,
        fromVersion: 1,
        toVersion: 2,
        documents,
        validateDocuments,
      });
    }
    for (const legacy of legacyEntries) {
      // Remove the state first. If the process exits before removing the binding, the binding keeps
      // the migration discoverable and the already-published v2 state remains authoritative.
      await rm(legacy.stateRoot, { recursive: true, force: true });
      await rm(legacy.bindingPath, { force: true });
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  });
}

function migrateAutomationRef(ref: string, projectId: string): string {
  return migrateLegacyPragmaResourceRef(ref, projectId);
}

function validateAutomationMigrationDocuments(
  paths: PragmaPaths,
  documents: Readonly<Record<string, unknown>>,
): void {
  const bindingPrefix = `${relative(paths.root, paths.automationBindingsRoot())}${sep}`;
  const statePrefix = `${relative(paths.root, paths.automationsStateRoot())}${sep}`;
  for (const [path, value] of Object.entries(documents)) {
    if (path.startsWith(bindingPrefix) && path.endsWith(".json")) {
      const binding = AutomationBindingV2Schema.parse(value);
      if (path !== relative(paths.root, paths.automationBinding(binding.automationRef)))
        throw new Error(`Automation migration binding identity mismatch: ${path}`);
      continue;
    }
    if (path.startsWith(statePrefix) && path.endsWith(`${sep}state.json`)) {
      const state = AutomationStateSchema.parse(value);
      if (path !== relative(paths.root, paths.automationState(state.automationRef)))
        throw new Error(`Automation migration state identity mismatch: ${path}`);
      continue;
    }
    throw new Error(`Automation migration contains an unexpected document: ${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function appendAutomationRun(
  state: AutomationState,
  run: AutomationRunRecord,
): AutomationState {
  return { ...state, runs: [...state.runs, run].slice(-100) };
}

async function readOptional<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
