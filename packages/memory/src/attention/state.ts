import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  PragmaPaths,
  withFileLock,
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
} from "@pragma/core";
import { z } from "zod";

import { ATTENTION_STORAGE_MIGRATIONS } from "../storage/migrations/attention/index.ts";
export const MEMORY_ATTENTION_VERSION = "pragma.memory-attention/v2";
export const MEMORY_ATTENTION_CONTEXT_ID = "mission-attention.md";
export const MEMORY_ATTENTION_HINT =
  "Memory attention changed. Relevant historical context is available at memory/mission-attention.md.";
export const MEMORY_ATTENTION_POLICY = Object.freeze({
  maxItems: 8,
  maxLensBytes: 24_576,
  maxLensTokens: 3_000,
  maxRounds: 3,
  maxDetails: 12,
  maxDeltaBytes: 4_096,
  maxRequestBytes: 24_576,
  maxQueries: 3,
  maxCandidates: 30,
  debounceMs: 250,
  minIntervalMs: 5_000,
  recallThreshold: 0.65,
  relevanceThreshold: 0.7,
  evictionThreshold: 0.35,
  halfLifeMs: 30 * 60_000,
  requestTimeoutMs: 3_000,
  auditMaxEntries: 100,
  auditRetentionMs: 7 * 86_400_000,
});

export const MemoryAttentionEntrySchema = z
  .object({
    module: z.enum(["episodic", "semantic"]),
    memoryId: z.string().min(1),
    revision: z.number().int().positive(),
    relevance: z.number().min(0).max(1),
    decisionMode: z.enum(["provider", "vector_unassessed"]),
    similarity: z.number().min(-1.00001).max(1.00001).optional(),
    confidence: z.number().min(0).max(1).optional(),
    pinned: z.literal(false),
    selectedPaths: z
      .array(
        z
          .object({
            fieldPath: z.string(),
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            textHash: z.string(),
          })
          .strict(),
      )
      .max(12),
    reason: z.enum(["new_error", "new_observation", "goal_changed", "historical_precedent"]),
    firstActivatedAt: z.string().datetime(),
    lastRelevantAt: z.string().datetime(),
  })
  .strict();
export const MemoryAttentionStateSchema = z
  .object({
    schemaVersion: z.literal(MEMORY_ATTENTION_VERSION),
    missionId: z.string().min(1),
    contextId: z.string().min(1),
    scopeDigest: z.string().min(1),
    generation: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    active: z.array(MemoryAttentionEntrySchema).max(8),
    lastDeltaDigest: z.string().optional(),
    taskVersion: z.number().int().nonnegative().optional(),
    lastHintedVersion: z.number().int().nonnegative().default(0),
    lastReadVersion: z.number().int().nonnegative().default(0),
    audit: z
      .array(
        z
          .object({
            occurredAt: z.string().datetime(),
            deltaDigest: z.string(),
            result: z.enum(["updated", "unchanged", "skipped", "failed"]),
            code: z.string().optional(),
            refs: z.array(z.string()).max(16),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type MemoryAttentionEntry = z.infer<typeof MemoryAttentionEntrySchema>;
export type MemoryAttentionState = z.infer<typeof MemoryAttentionStateSchema>;
export interface MemoryAttentionStateStore {
  read(missionId: string, contextId: string): Promise<MemoryAttentionState | undefined>;
  update(
    missionId: string,
    contextId: string,
    updater: (current: MemoryAttentionState | undefined) => MemoryAttentionState | undefined,
  ): Promise<MemoryAttentionState | undefined>;
}

export async function readAttentionJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isAttentionNotFound(error)) return undefined;
    throw error;
  }
}
export function isAttentionNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export async function writeAttentionJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
export function createFileMemoryAttentionStateStore(options: {
  pragmaHome?: string;
}): MemoryAttentionStateStore {
  const paths = new PragmaPaths(options);
  const readUnlocked = async (missionId: string, contextId: string) => {
    const path = paths.memoryAttentionState(missionId, contextId),
      aggregateRoot = dirname(path),
      name = basename(path),
      journalFile = `${path}.state-migration.json`;
    const resource = { family: "pragma.memory-attention", id: name };
    await recoverAtomicStateMigration({
      aggregateRoot,
      journalFile,
      resource,
      validateDocuments: (documents) => {
        MemoryAttentionStateSchema.parse(documents[name]);
      },
    });
    let value = await readAttentionJson(path);
    if (value === undefined) return undefined;
    for (const step of ATTENTION_STORAGE_MIGRATIONS) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("schemaVersion" in value) ||
        value.schemaVersion !== step.sourceVersion
      )
        continue;
      const next = step.migrate(value);
      const backupRoot = join(aggregateRoot, "migrations", "backups");
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      await copyFile(
        path,
        join(
          backupRoot,
          `${createHash("sha256").update(JSON.stringify(value)).digest("hex")}.attention-v1.json`,
        ),
      );
      await applyAtomicStateMigration({
        aggregateRoot,
        journalFile,
        resource,
        fromVersion: step.fromVersion,
        toVersion: step.toVersion,
        documents: { [name]: next },
        validateDocuments: (documents) => {
          MemoryAttentionStateSchema.parse(documents[name]);
        },
      });
      value = next;
    }
    const state = MemoryAttentionStateSchema.parse(value);
    if (state.missionId !== missionId || state.contextId !== contextId)
      throw new Error("attention_owner_mismatch");
    return state;
  };
  const read = (missionId: string, contextId: string) =>
    withFileLock(`${paths.memoryAttentionState(missionId, contextId)}.lock`, () =>
      readUnlocked(missionId, contextId),
    );
  return {
    read,
    async update(missionId, contextId, updater) {
      const path = paths.memoryAttentionState(missionId, contextId);
      return await withFileLock(`${path}.lock`, async () => {
        const current = await readUnlocked(missionId, contextId);
        const next = updater(current);
        if (next === undefined) return current;
        const parsed = MemoryAttentionStateSchema.parse(next);
        if (parsed.missionId !== missionId || parsed.contextId !== contextId)
          throw new Error("attention_owner_mismatch");
        await writeAttentionJson(path, parsed);
        return parsed;
      });
    },
  };
}
