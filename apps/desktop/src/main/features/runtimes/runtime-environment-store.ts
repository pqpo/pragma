import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";

import {
  RuntimeEnvironmentCatalogEntrySchema,
  RuntimeEnvironmentCatalogSchema,
  RuntimeEnvironmentDefinitionSchema,
  RuntimeEnvironmentRevisionSchema,
  type RuntimeEnvironmentCatalogEntry,
  type RuntimeEnvironmentDefinition,
  type RuntimeEnvironmentRevision,
} from "../../../shared/contracts/index.ts";

export const DEFAULT_RUNTIME_ID = "pi";

export const DEFAULT_RUNTIME_ENVIRONMENTS: readonly RuntimeEnvironmentDefinition[] = [
  environment("pi", "PI Runtime", "pragma.runtime.pi"),
  environment("codex", "Codex", "pragma.runtime.codex"),
  environment("claude-code", "Claude Code", "pragma.runtime.claude-code"),
];

export interface RuntimeEnvironmentHead {
  readonly entry: RuntimeEnvironmentCatalogEntry;
  readonly revision?: RuntimeEnvironmentRevision | undefined;
  readonly error?: string | undefined;
}

export interface RuntimeEnvironmentStore {
  initialize(): Promise<void>;
  getDefaultRuntimeId(): Promise<string>;
  setDefaultRuntimeId(runtimeId: string): Promise<void>;
  listHeads(): Promise<readonly RuntimeEnvironmentHead[]>;
  getRevision(
    runtimeId: string,
    revision?: number,
  ): Promise<RuntimeEnvironmentRevision | undefined>;
  create(definition: RuntimeEnvironmentDefinition): Promise<RuntimeEnvironmentRevision>;
  update(input: {
    readonly definition: RuntimeEnvironmentDefinition;
    readonly expectedRevision: number;
  }): Promise<RuntimeEnvironmentRevision>;
  delete(input: {
    readonly runtimeId: string;
    readonly expectedRevision: number;
  }): Promise<RuntimeEnvironmentRevision>;
}

export function createRuntimeEnvironmentStore(options: {
  readonly pragmaHome?: string | undefined;
  readonly builtIns?: readonly RuntimeEnvironmentDefinition[] | undefined;
  readonly defaultRuntimeId?: string | undefined;
}): RuntimeEnvironmentStore {
  const paths = new PragmaPaths(options);
  const catalogPath = paths.runtimeEnvironmentCatalog();
  const lockPath = `${catalogPath}.lock`;
  const builtIns = options.builtIns ?? DEFAULT_RUNTIME_ENVIRONMENTS;
  const configuredDefault = options.defaultRuntimeId ?? DEFAULT_RUNTIME_ID;
  const persistRevision = async (revision: RuntimeEnvironmentRevision): Promise<void> => {
    const path = paths.runtimeEnvironmentRevision(revision.runtimeId, revision.revision);
    const existingValue = await readOptionalJson(path);
    if (existingValue === undefined) {
      await writeJson(path, revision);
      return;
    }
    const existing = RuntimeEnvironmentRevisionSchema.parse(existingValue);
    if (
      existing.fingerprint !== revision.fingerprint ||
      existing.status !== revision.status ||
      stableStringify(existing.definition) !== stableStringify(revision.definition)
    ) {
      throw new Error(
        `Runtime Environment revision is immutable: ${revision.runtimeId}@${revision.revision}.`,
      );
    }
  };

  const initialize = async (): Promise<void> => {
    await withFileLock(lockPath, async () => {
      if ((await readOptionalJson(catalogPath)) !== undefined) return;
      if (!builtIns.some((definition) => definition.id === configuredDefault)) {
        throw new Error(`Default Runtime Environment is not built in: ${configuredDefault}.`);
      }
      const now = new Date().toISOString();
      const entries: RuntimeEnvironmentCatalogEntry[] = [];
      for (const definition of builtIns) {
        const revision = createRevision(definition, 1, "active", now);
        await persistRevision(revision);
        entries.push({ runtimeId: definition.id, latestRevision: 1 });
      }
      await writeCatalog(catalogPath, configuredDefault, entries);
    });
  };

  const readCatalog = async () => {
    await initialize();
    return RuntimeEnvironmentCatalogSchema.parse(await requireJson(catalogPath));
  };

  const readEntries = async (): Promise<readonly RuntimeEnvironmentCatalogEntry[]> => {
    const catalog = await readCatalog();
    return catalog.entries.flatMap((value) => {
      const parsed = RuntimeEnvironmentCatalogEntrySchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    });
  };

  const getRevision = async (
    runtimeId: string,
    revision?: number,
  ): Promise<RuntimeEnvironmentRevision | undefined> => {
    const entry = (await readEntries()).find((candidate) => candidate.runtimeId === runtimeId);
    const targetRevision = revision ?? entry?.latestRevision;
    if (targetRevision === undefined) return undefined;
    return await readStoredRevision(runtimeId, targetRevision);
  };

  const readStoredRevision = async (
    runtimeId: string,
    revision: number,
  ): Promise<RuntimeEnvironmentRevision | undefined> => {
    const value = await readOptionalJson(paths.runtimeEnvironmentRevision(runtimeId, revision));
    if (value === undefined) return undefined;
    return RuntimeEnvironmentRevisionSchema.parse(value);
  };

  const mutate = async <T>(
    action: (state: {
      readonly defaultRuntimeId: string;
      readonly entries: readonly RuntimeEnvironmentCatalogEntry[];
    }) => Promise<{
      readonly result: T;
      readonly defaultRuntimeId?: string | undefined;
      readonly entries: readonly RuntimeEnvironmentCatalogEntry[];
    }>,
  ): Promise<T> => {
    await initialize();
    return await withFileLock(lockPath, async () => {
      const catalog = RuntimeEnvironmentCatalogSchema.parse(await requireJson(catalogPath));
      const entries = catalog.entries.map((value) =>
        RuntimeEnvironmentCatalogEntrySchema.parse(value),
      );
      const next = await action({ defaultRuntimeId: catalog.defaultRuntimeId, entries });
      await writeCatalog(
        catalogPath,
        next.defaultRuntimeId ?? catalog.defaultRuntimeId,
        next.entries,
      );
      return next.result;
    });
  };

  return {
    initialize,
    async getDefaultRuntimeId() {
      return (await readCatalog()).defaultRuntimeId;
    },
    async setDefaultRuntimeId(runtimeId) {
      await mutate(async ({ entries }) => {
        const entry = entries.find((candidate) => candidate.runtimeId === runtimeId);
        if (entry === undefined) throw new Error(`Runtime Environment not found: ${runtimeId}.`);
        const revision = await readStoredRevision(runtimeId, entry.latestRevision);
        if (revision?.status !== "active") {
          throw new Error(`Default Runtime Environment must be active: ${runtimeId}.`);
        }
        return { result: undefined, defaultRuntimeId: runtimeId, entries };
      });
    },
    async listHeads() {
      const entries = await readEntries();
      return await Promise.all(
        entries.map(async (entry): Promise<RuntimeEnvironmentHead> => {
          try {
            const revision = await getRevision(entry.runtimeId, entry.latestRevision);
            if (revision === undefined) {
              return {
                entry,
                error: `Runtime Environment revision is missing: ${entry.runtimeId}@${entry.latestRevision}.`,
              };
            }
            return { entry, revision };
          } catch (error) {
            return { entry, error: errorMessage(error) };
          }
        }),
      );
    },
    getRevision,
    async create(definition) {
      const parsed = RuntimeEnvironmentDefinitionSchema.parse(definition);
      return await mutate(async ({ entries }) => {
        if (entries.some((entry) => entry.runtimeId === parsed.id)) {
          throw new Error(`Runtime Environment already exists: ${parsed.id}.`);
        }
        const revision = createRevision(parsed, 1, "active");
        await persistRevision(revision);
        return {
          result: revision,
          entries: [...entries, { runtimeId: parsed.id, latestRevision: 1 }],
        };
      });
    },
    async update({ definition, expectedRevision }) {
      const parsed = RuntimeEnvironmentDefinitionSchema.parse(definition);
      return await mutate(async ({ entries }) => {
        const entry = entries.find((candidate) => candidate.runtimeId === parsed.id);
        if (entry === undefined) throw new Error(`Runtime Environment not found: ${parsed.id}.`);
        assertRevision(entry, expectedRevision);
        const revision = createRevision(parsed, expectedRevision + 1, "active");
        await persistRevision(revision);
        return {
          result: revision,
          entries: entries.map((candidate) =>
            candidate.runtimeId === parsed.id
              ? { ...candidate, latestRevision: revision.revision }
              : candidate,
          ),
        };
      });
    },
    async delete({ runtimeId, expectedRevision }) {
      return await mutate(async ({ defaultRuntimeId, entries }) => {
        if (runtimeId === defaultRuntimeId) {
          throw new Error("Set another default Runtime Environment before deleting this one.");
        }
        const entry = entries.find((candidate) => candidate.runtimeId === runtimeId);
        if (entry === undefined) throw new Error(`Runtime Environment not found: ${runtimeId}.`);
        assertRevision(entry, expectedRevision);
        const current = await readStoredRevision(runtimeId, expectedRevision);
        if (current === undefined)
          throw new Error(
            `Runtime Environment revision is missing: ${runtimeId}@${expectedRevision}.`,
          );
        const revision = createRevision(current.definition, expectedRevision + 1, "deleted");
        await persistRevision(revision);
        return {
          result: revision,
          entries: entries.map((candidate) =>
            candidate.runtimeId === runtimeId
              ? { ...candidate, latestRevision: revision.revision }
              : candidate,
          ),
        };
      });
    },
  };
}

function createRevision(
  definition: RuntimeEnvironmentDefinition,
  revision: number,
  status: RuntimeEnvironmentRevision["status"],
  createdAt = new Date().toISOString(),
): RuntimeEnvironmentRevision {
  return RuntimeEnvironmentRevisionSchema.parse({
    schemaVersion: "pragma.runtime-environment-revision/v1",
    runtimeId: definition.id,
    revision,
    fingerprint: createHash("sha256")
      .update(stableStringify({ definition, revision, status }))
      .digest("hex"),
    definition,
    status,
    createdAt,
  });
}

async function writeCatalog(
  path: string,
  defaultRuntimeId: string,
  entries: readonly RuntimeEnvironmentCatalogEntry[],
): Promise<void> {
  await writeJson(path, {
    schemaVersion: "pragma.runtime-environment-catalog/v1",
    defaultRuntimeId,
    entries,
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function requireJson(path: string): Promise<unknown> {
  const value = await readOptionalJson(path);
  if (value === undefined) throw new Error(`Runtime Environment state is missing: ${path}.`);
  return value;
}

function assertRevision(entry: RuntimeEnvironmentCatalogEntry, expectedRevision: number): void {
  if (entry.latestRevision !== expectedRevision) {
    throw new Error(
      `Runtime Environment revision conflict: expected ${expectedRevision}, current ${entry.latestRevision}.`,
    );
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Runtime Environment is invalid.";
}

function environment(
  id: string,
  displayName: string,
  adapterId: string,
): RuntimeEnvironmentDefinition {
  return RuntimeEnvironmentDefinitionSchema.parse({
    schemaVersion: "pragma.runtime-environment/v1",
    id,
    adapter: { id: adapterId, version: "v1" },
    displayName,
    origin: "built-in",
    config: {},
  });
}
