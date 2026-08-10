import type { DatabaseSync } from "node:sqlite";
import type { MemorySubjectRef, SemanticFact } from "@pragma/shared";

import type { EpisodicMemoryRecord } from "../episodic/schema.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";

const DAY_MS = 86_400_000;

interface IndexState {
  readonly recallCount: number;
  readonly lastRecalledAt?: string | undefined;
}

export function hotEpisodes(
  database: DatabaseSync,
  records: readonly EpisodicMemoryRecord[],
  scope: MemoryRecallScope,
  now: Date,
): EpisodicMemoryRecord[] {
  return selectHot(database, records, scope, now, 200, 0.25, (record, state) =>
    clamp(
      0.55 * record.valueScore +
        0.25 * decay(record.updatedAt, now, 90) +
        0.2 * recallDecay(state, now, 60),
    ),
  );
}

export function hotFacts(
  database: DatabaseSync,
  records: readonly SemanticFact[],
  scope: MemoryRecallScope,
  now: Date,
): SemanticFact[] {
  return selectHot(database, records, scope, now, 500, 0.3, (record, state) =>
    clamp(
      0.45 * record.confidence +
        (record.verifiedAt === undefined ? 0 : 0.2) +
        0.2 * decay(record.updatedAt, now, 180) +
        0.15 * recallDecay(state, now, 90) -
        (record.conflictsWith.length === 0 ? 0 : 0.15) -
        (record.reviewAt !== undefined && record.reviewAt <= now.toISOString() ? 0.15 : 0),
    ),
  );
}

export function recordMemoryRecall(
  database: DatabaseSync,
  memoryId: string,
  scope: MemoryRecallScope,
  now: Date,
): void {
  for (const ref of uniqueRefs([
    scope.rootRef,
    ...(scope.expertRef === undefined ? [] : [scope.expertRef]),
  ])) {
    const key = refKey(ref);
    database
      .prepare(
        `INSERT INTO memory_index(memory_id, consumer_key, tier, score, recall_count, last_recalled_at, computed_at)
         VALUES (?, ?, 'archived', 0, 1, ?, ?)
         ON CONFLICT(memory_id, consumer_key) DO UPDATE SET
           recall_count = memory_index.recall_count + 1,
           last_recalled_at = excluded.last_recalled_at`,
      )
      .run(memoryId, key, now.toISOString(), now.toISOString());
  }
}

function selectHot<
  T extends {
    readonly id: string;
    readonly bindings: readonly {
      readonly consumerRef: MemorySubjectRef;
      readonly recall: "allow" | "deny";
    }[];
  },
>(
  database: DatabaseSync,
  records: readonly T[],
  scope: MemoryRecallScope,
  now: Date,
  limit: number,
  threshold: number,
  score: (record: T, state: IndexState) => number,
): T[] {
  const selected = new Map<string, { readonly record: T; readonly score: number }>();
  for (const ref of uniqueRefs([
    scope.rootRef,
    ...(scope.expertRef === undefined ? [] : [scope.expertRef]),
  ])) {
    const key = refKey(ref);
    const ranked = records
      .filter((record) =>
        record.bindings.some(
          (binding) => binding.recall === "allow" && refKey(binding.consumerRef) === key,
        ),
      )
      .map((record) => {
        const state = readState(database, record.id, key);
        return { record, score: score(record, state) };
      })
      .toSorted(
        (left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id),
      );
    const hotIds = new Set(
      ranked
        .filter((item) => item.score >= threshold)
        .slice(0, limit)
        .map((item) => item.record.id),
    );
    for (const item of ranked) {
      writeState(
        database,
        item.record.id,
        key,
        hotIds.has(item.record.id) ? "hot" : "archived",
        item.score,
        now,
      );
      if (!hotIds.has(item.record.id)) continue;
      const previous = selected.get(item.record.id);
      if (previous === undefined || item.score > previous.score) selected.set(item.record.id, item);
    }
  }
  return [...selected.values()]
    .toSorted(
      (left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id),
    )
    .map((item) => item.record);
}

function readState(database: DatabaseSync, memoryId: string, consumerKey: string): IndexState {
  const row = database
    .prepare(
      "SELECT recall_count AS recallCount, last_recalled_at AS lastRecalledAt FROM memory_index WHERE memory_id = ? AND consumer_key = ?",
    )
    .get(memoryId, consumerKey) as
    { readonly recallCount: number; readonly lastRecalledAt: string | null } | undefined;
  return row === undefined
    ? { recallCount: 0 }
    : {
        recallCount: row.recallCount,
        ...(row.lastRecalledAt === null ? {} : { lastRecalledAt: row.lastRecalledAt }),
      };
}

function writeState(
  database: DatabaseSync,
  memoryId: string,
  consumerKey: string,
  tier: "hot" | "archived",
  score: number,
  now: Date,
): void {
  database
    .prepare(
      `INSERT INTO memory_index(memory_id, consumer_key, tier, score, recall_count, computed_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(memory_id, consumer_key) DO UPDATE SET
         tier = excluded.tier, score = excluded.score, computed_at = excluded.computed_at`,
    )
    .run(memoryId, consumerKey, tier, score, now.toISOString());
}

function decay(timestamp: string, now: Date, halfLifeDays: number): number {
  const age = Math.max(0, now.getTime() - Date.parse(timestamp));
  return 2 ** (-age / (halfLifeDays * DAY_MS));
}

function recallDecay(state: IndexState, now: Date, halfLifeDays: number): number {
  if (state.lastRecalledAt === undefined || state.recallCount === 0) return 0;
  return decay(state.lastRecalledAt, now, halfLifeDays);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}
