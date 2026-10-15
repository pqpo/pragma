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
    for (const row of rows) {
      onRemove?.(row.jobJson);
      deleteExtractionFailureAttempts(database, row.id);
      remove.run(row.id);
    }
    database.exec("COMMIT;");
    return rows.length;
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export async function retainMemoryExtractionHistory(stores: {
  readonly episodicStore: Pick<
    import("../episodic/store.ts").EpisodicMemoryStore,
    "listExtractionJobsPage" | "pruneCompletedJobs"
  >;
  readonly semanticStore: Pick<
    import("../semantic/store.ts").SemanticMemoryStore,
    "listExtractionJobsPage" | "pruneCompletedJobs"
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
  await retainCompletedMemoryJobs([
    {
      module: "episodic",
      list: (input) => stores.episodicStore.listExtractionJobsPage(input),
      prune: (before) => stores.episodicStore.pruneCompletedJobs(before),
    },
    {
      module: "semantic",
      list: (input) => stores.semanticStore.listExtractionJobsPage(input),
      prune: (before) => stores.semanticStore.pruneCompletedJobs(before),
    },
    {
      module: "knowledge",
      list: (input) => stores.knowledgeLearningStore.listJobsPage(input),
      prune: (before) => stores.knowledgeLearningStore.pruneCompletedJobs(before),
    },
    {
      module: "skill",
      list: (input) => stores.skillLearningStore.listJobsPage(input),
      prune: (before) => stores.skillLearningStore.pruneCompletedJobs(before),
    },
  ]);
}
