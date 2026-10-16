import { conversationExtractionJobId } from "./conversation-extraction.ts";
import type { DatabaseSync } from "node:sqlite";

import { deleteExtractionFailureAttempts } from "./extraction-failure-store.ts";
import type { MemoryJobPage, MemoryJobPageInput } from "./memory-job-page.ts";

export const COMPLETED_MEMORY_JOB_LIMIT = 50;

export interface CompletedMemoryJobCursor {
  readonly updatedAt: string;
  readonly tieBreaker: string;
}

interface CompletedJobStore {
  readonly module: string;
  list(
    input: MemoryJobPageInput<"completed">,
  ): Promise<MemoryJobPage<{ readonly id: string; readonly updatedAt: string }>>;
  prune(before: CompletedMemoryJobCursor): Promise<number>;
}

/** Keep the newest completed tasks across all modules, using the board's stable ordering. */
export async function retainCompletedMemoryJobs(
  stores: readonly CompletedJobStore[],
): Promise<void> {
  const pages = await Promise.all(
    stores.map(async (store) => {
      const page = await store.list({
        statuses: ["completed"],
        limit: COMPLETED_MEMORY_JOB_LIMIT,
        sortKeyPrefix: store.module,
      });
      return {
        total: page.total,
        jobs: page.jobs.map((job) => ({
          updatedAt: job.updatedAt,
          tieBreaker: `${store.module}:${job.id}`,
        })),
      };
    }),
  );
  if (pages.reduce((total, page) => total + page.total, 0) <= COMPLETED_MEMORY_JOB_LIMIT) return;
  const jobs = pages
    .flatMap((page) => page.jobs)
    .sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? a.tieBreaker < b.tieBreaker
          ? 1
          : a.tieBreaker > b.tieBreaker
            ? -1
            : 0
        : a.updatedAt < b.updatedAt
          ? 1
          : -1,
    );
  const before = jobs[COMPLETED_MEMORY_JOB_LIMIT - 1]!;
  for (const store of stores) await store.prune(before);
}

/** Recheck completed status inside the write transaction; newer/concurrent work is preserved. */
export function pruneCompletedMemoryJobs(
  database: DatabaseSync,
  module: string,
  before: CompletedMemoryJobCursor,
  onRemove?: (jobJson: string) => void,
  keepIds: readonly string[] = [],
): number {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const rows = database
      .prepare(
        `SELECT id, job_json AS jobJson FROM jobs WHERE status='completed' AND (
      json_extract(job_json, '$.updatedAt') < ? OR
      (json_extract(job_json, '$.updatedAt') = ? AND (? || ':' || id) < ?)
    )`,
      )
      .all(before.updatedAt, before.updatedAt, module, before.tieBreaker) as {
      readonly id: string;
      readonly jobJson: string;
    }[];
    const remove = database.prepare("DELETE FROM jobs WHERE id=?");
    const keep = new Set(keepIds);
    let removed = 0;
    for (const row of rows) {
      if (keep.has(row.id)) continue;
      removed++;
      onRemove?.(row.jobJson);
      deleteExtractionFailureAttempts(database, row.id);
      remove.run(row.id);
    }
    database.exec("COMMIT;");
    return removed;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export async function retainMemoryExtractionHistory(stores: {
  readonly episodicStore: Pick<
    import("../episodic/store.ts").EpisodicMemoryStore,
    "listExtractionJobs" | "pruneCompletedJobs"
  >;
  readonly semanticStore: Pick<
    import("../semantic/store.ts").SemanticMemoryStore,
    "listExtractionJobs" | "pruneCompletedJobs"
  >;
  readonly knowledgeLearningStore: Pick<
    import("../knowledge/store.ts").KnowledgeLearningStore,
    "listJobsPage" | "pruneCompletedJobs"
  >;
  readonly skillLearningStore: Pick<
    import("../skill/store.ts").SkillLearningStore,
    "listJobsPage" | "pruneCompletedJobs"
  >;
}): Promise<void> {
  const [episodic, semantic, knowledge, skill] = await Promise.all([
    stores.episodicStore.listExtractionJobs(),
    stores.semanticStore.listExtractionJobs(),
    stores.knowledgeLearningStore.listJobsPage({
      statuses: ["completed"],
      limit: COMPLETED_MEMORY_JOB_LIMIT,
      sortKeyPrefix: "knowledge",
    }),
    stores.skillLearningStore.listJobsPage({
      statuses: ["completed"],
      limit: COMPLETED_MEMORY_JOB_LIMIT,
      sortKeyPrefix: "skill",
    }),
  ]);
  const groups = new Map<
    string,
    { module: "episodic" | "semantic"; id: string; completed: boolean; updatedAt: string }[]
  >();
  for (const [module, jobs] of [
    ["episodic", episodic],
    ["semantic", semantic],
  ] as const)
    for (const job of jobs) {
      if (job.status === "expired") continue;
      const key = conversationExtractionJobId(job.conversationRef, job.inputWatermark);
      const members = groups.get(key) ?? [];
      members.push({
        module,
        id: job.id,
        completed: job.status === "completed",
        updatedAt: job.updatedAt,
      });
      groups.set(key, members);
    }
  const conversation = [...groups]
    .filter(([, members]) => members.every((member) => member.completed))
    .map(([id, members]) => ({
      updatedAt: members
        .map((member) => member.updatedAt)
        .toSorted()
        .at(-1)!,
      tieBreaker: `conversation:${id}`,
    }));
  if (conversation.length + knowledge.total + skill.total <= COMPLETED_MEMORY_JOB_LIMIT) return;
  const newest = [
    ...conversation,
    ...knowledge.jobs.map((job) => ({
      updatedAt: job.updatedAt,
      tieBreaker: `knowledge:${job.id}`,
    })),
    ...skill.jobs.map((job) => ({ updatedAt: job.updatedAt, tieBreaker: `skill:${job.id}` })),
  ]
    .toSorted(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.tieBreaker.localeCompare(a.tieBreaker),
    )
    .slice(0, COMPLETED_MEMORY_JOB_LIMIT);
  const retained = new Set(newest.map((job) => job.tieBreaker));
  const keep = { episodic: [] as string[], semantic: [] as string[] };
  for (const [id, members] of groups) {
    // A completed half of an unfinished task is never a completed-history eviction candidate.
    if (!members.every((member) => member.completed) || retained.has(`conversation:${id}`))
      for (const member of members) keep[member.module].push(member.id);
  }
  const all = { updatedAt: "9999-12-31T23:59:59.999Z", tieBreaker: "~" };
  await stores.episodicStore.pruneCompletedJobs(all, keep.episodic);
  await stores.semanticStore.pruneCompletedJobs(all, keep.semantic);
  const before = newest.at(-1)!;
  await stores.knowledgeLearningStore.pruneCompletedJobs(before);
  await stores.skillLearningStore.pruneCompletedJobs(before);
}
