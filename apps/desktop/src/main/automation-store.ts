import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  applyAtomicStateMigration,
  PragmaPaths,
  recoverAtomicStateMigration,
  withFileLock,
} from "@pragma/core";
import { z } from "zod";

import {
  AutomationBindingSchema,
  AutomationRunRecordSchema,
  type AutomationBinding,
  type AutomationRunRecord,
} from "../shared/desktop-api.ts";
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
    migration ??= migrateAutomationStorageV1(paths, projectId);
    await migration;
  };
  const readBinding = async (ref: string): Promise<AutomationBinding | undefined> => {
    await ensureMigrated();
    return await readOptional(paths.automationBinding(ref), AutomationBindingSchema);
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
      await writeJsonAtomic(paths.automationBinding(parsed.automationRef), parsed);
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
    async remove(ref) {
      await ensureMigrated();
      await Promise.all([
        rm(paths.automationBinding(ref), { force: true }),
        rm(paths.automationStateRoot(ref), { recursive: true, force: true }),
      ]);
    },
  };
}

export function createAutomationBinding(input: {
  readonly automationRef: string;
  readonly previous?: AutomationBinding | undefined;
  readonly rotateGeneration: boolean;
  readonly workspace: AutomationBinding["workspace"];
  readonly toolPermissionMode: AutomationBinding["toolPermissionMode"];
  readonly modelOverride?: AutomationBinding["modelOverride"] | undefined;
}): AutomationBinding {
  const now = new Date().toISOString();
  return AutomationBindingSchema.parse({
    schemaVersion: "pragma.automation-binding/v2",
    automationRef: input.automationRef,
    revision: (input.previous?.revision ?? 0) + 1,
    generation:
      input.previous === undefined || input.rotateGeneration
        ? randomUUID()
        : input.previous.generation,
    workspace: input.workspace,
    placement: "desktop",
    toolPermissionMode: input.toolPermissionMode,
    ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
    createdAt: input.previous?.createdAt ?? now,
    updatedAt: now,
  });
}

const AutomationBindingV1Schema = AutomationBindingSchema.extend({
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
      if (current.success) continue;
      const legacy = AutomationBindingV1Schema.parse(raw);
      const ref = migrateAutomationRef(legacy.automationRef, projectId);
      const migrated = AutomationBindingSchema.parse({
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
      AutomationBindingSchema.parse(value);
      continue;
    }
    if (path.startsWith(statePrefix) && path.endsWith(`${sep}state.json`)) {
      AutomationStateSchema.parse(value);
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
