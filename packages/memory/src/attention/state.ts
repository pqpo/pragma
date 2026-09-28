import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PragmaPaths, withFileLock } from "@pragma/core";
import { z } from "zod";

export const MEMORY_ATTENTION_CONTEXT_ID = "mission-attention.md";
export const MEMORY_ATTENTION_HINT =
  "Memory attention changed. Relevant historical context is available at memory/mission-attention.md.";
export const MEMORY_ATTENTION_POLICY = Object.freeze({
  maxItems: 8,
  maxLensBytes: 8_192,
  maxDeltaBytes: 4_096,
  maxRequestBytes: 24_576,
  maxQueries: 3,
  maxCandidates: 8,
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
    reason: z.enum(["new_error", "new_observation", "goal_changed", "historical_precedent"]),
    firstActivatedAt: z.string().datetime(),
    lastRelevantAt: z.string().datetime(),
  })
  .strict();
export const MemoryAttentionStateSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-attention/v1"),
    missionId: z.string().min(1),
    contextId: z.string().min(1),
    scopeDigest: z.string().min(1),
    generation: z.number().int().nonnegative(),
    version: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    active: z.array(MemoryAttentionEntrySchema).max(8),
    lastDeltaDigest: z.string().optional(),
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
  const read = async (missionId: string, contextId: string) => {
    const value = await readAttentionJson(paths.memoryAttentionState(missionId, contextId));
    if (value === undefined) return undefined;
    const state = MemoryAttentionStateSchema.parse(value);
    if (state.missionId !== missionId || state.contextId !== contextId)
      throw new Error("attention_owner_mismatch");
    return state;
  };
  return {
    read,
    async update(missionId, contextId, updater) {
      const path = paths.memoryAttentionState(missionId, contextId);
      return await withFileLock(`${path}.lock`, async () => {
        const current = await read(missionId, contextId);
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
