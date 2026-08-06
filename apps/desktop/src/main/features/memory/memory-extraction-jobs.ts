import type { EpisodicExtractionJob, SemanticExtractionJob } from "@pragma/memory";
import type { KnowledgeExtractionJob } from "@pragma/shared";
import type { SkillLearningJob } from "@pragma/shared";

import {
  DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE,
  DesktopMemoryExtractionBoardSchema,
  type DesktopMemoryExtractionBoard,
  type DesktopMemoryExtractionTask,
  type ListDesktopMemoryExtractionJobs,
} from "../../../shared/contracts/index.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";

const MEMORY_EXTRACTION_LANES = ["waiting", "attention", "running", "completed"] as const;
type MemoryExtractionLane = (typeof MEMORY_EXTRACTION_LANES)[number];
type ConversationExtractionJob = EpisodicExtractionJob | SemanticExtractionJob;
type PagedExtractionJob =
  | {
      readonly module: "episodic" | "semantic";
      readonly lane: MemoryExtractionLane;
      readonly job: ConversationExtractionJob;
    }
  | {
      readonly module: "knowledge";
      readonly lane: MemoryExtractionLane;
      readonly job: KnowledgeExtractionJob;
    }
  | {
      readonly module: "skill";
      readonly lane: MemoryExtractionLane;
      readonly job: SkillLearningJob;
    };

interface LoadedLanePage {
  readonly jobs: readonly PagedExtractionJob[];
  readonly pageIndex: number;
  readonly pageCount: number;
  readonly totalTasks: number;
}

export async function listDesktopMemoryExtractionJobs(
  plane: Pick<
    DesktopMemoryPlane,
    "episodicStore" | "semanticStore" | "knowledgeLearningStore" | "skillLearningStore"
  >,
  options: {
    readonly missions: Pick<MissionStore, "get" | "resolveExecutionTitles">;
    readonly project: Pick<PragmaProjectStore, "get">;
  },
  input: ListDesktopMemoryExtractionJobs,
): Promise<DesktopMemoryExtractionBoard> {
  const loadedPages = await Promise.all(
    MEMORY_EXTRACTION_LANES.map(async (lane) => loadLanePage(plane, lane, input.pages[lane])),
  );
  const jobs = loadedPages.flatMap((page) => page.jobs);
  const conversationJobs = jobs.filter(
    (entry): entry is Extract<PagedExtractionJob, { module: "episodic" | "semantic" }> =>
      entry.module === "episodic" || entry.module === "semantic",
  );
  const missionIds = [
    ...new Set(
      conversationJobs
        .filter((entry) => entry.job.conversationRef.type === "pragma.mission")
        .map((entry) => entry.job.conversationRef.id),
    ),
  ];
  const executionIds = conversationJobs
    .filter((entry) => entry.job.conversationRef.type === "pragma.execution")
    .map((entry) => entry.job.conversationRef.id);
  const [missionResults, executionTitles, project] = await Promise.all([
    Promise.allSettled(missionIds.map(async (id) => await options.missions.get(id))),
    options.missions.resolveExecutionTitles(executionIds),
    jobs.some((entry) => entry.module === "knowledge" || entry.module === "skill")
      ? options.project.get()
      : Promise.resolve(undefined),
  ]);
  const missionTitles = new Map<string, string>();
  missionResults.forEach((result, index) => {
    if (result.status === "fulfilled") missionTitles.set(missionIds[index]!, result.value.title);
  });
  const resourceTitles = new Map(
    project?.resources.map((resource) => [resource.metadata.id, resource.metadata.name]) ?? [],
  );

  return DesktopMemoryExtractionBoardSchema.parse({
    lanes: Object.fromEntries(
      MEMORY_EXTRACTION_LANES.map((lane, index) => {
        const page = loadedPages[index]!;
        const tasks = page.jobs.map((entry) =>
          toDesktopTask(entry, missionTitles, executionTitles, resourceTitles),
        );
        return [
          lane,
          {
            tasks,
            pageIndex: page.pageIndex,
            pageCount: page.pageCount,
            totalTasks: page.totalTasks,
            ...((page.pageIndex + 1) * DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE < page.totalTasks &&
            tasks.at(-1) !== undefined
              ? { nextCursor: taskCursor(tasks.at(-1)!) }
              : {}),
          },
        ];
      }),
    ),
  });
}

async function loadLanePage(
  plane: Pick<DesktopMemoryPlane, "episodicStore" | "semanticStore" | "knowledgeLearningStore"> &
    Partial<Pick<DesktopMemoryPlane, "skillLearningStore">>,
  lane: MemoryExtractionLane,
  request: ListDesktopMemoryExtractionJobs["pages"][MemoryExtractionLane],
): Promise<LoadedLanePage> {
  const query = async (cursor: typeof request.cursor) => {
    const common = {
      limit: DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE,
      ...(cursor === undefined ? {} : { before: cursor }),
    };
    const [episodic, semantic, knowledge, skill] = await Promise.all([
      plane.episodicStore.listExtractionJobsPage({
        ...common,
        statuses: conversationStatuses(lane),
        sortKeyPrefix: "episodic",
      }),
      plane.semanticStore.listExtractionJobsPage({
        ...common,
        statuses: conversationStatuses(lane),
        sortKeyPrefix: "semantic",
      }),
      plane.knowledgeLearningStore.listJobsPage({
        ...common,
        statuses: knowledgeStatuses(lane),
        sortKeyPrefix: "knowledge",
      }),
      plane.skillLearningStore?.listJobsPage({
        ...common,
        statuses: knowledgeStatuses(lane),
        sortKeyPrefix: "skill",
      }) ?? Promise.resolve({ jobs: [], total: 0 }),
    ]);
    const jobs: PagedExtractionJob[] = [
      ...episodic.jobs.map((job) => ({ module: "episodic" as const, lane, job })),
      ...semantic.jobs.map((job) => ({ module: "semantic" as const, lane, job })),
      ...knowledge.jobs.map((job) => ({ module: "knowledge" as const, lane, job })),
      ...skill.jobs.map((job) => ({ module: "skill" as const, lane, job })),
    ];
    return {
      jobs: jobs.toSorted(compareJobs).slice(0, DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE),
      totalTasks: episodic.total + semantic.total + knowledge.total + skill.total,
    };
  };

  let result = await query(request.cursor);
  const pageCount = Math.max(1, Math.ceil(result.totalTasks / DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE));
  if (request.pageIndex >= pageCount || (request.pageIndex > 0 && result.jobs.length === 0)) {
    result = await query(undefined);
    return {
      ...result,
      pageIndex: 0,
      pageCount: Math.max(1, Math.ceil(result.totalTasks / DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE)),
    };
  }
  return { ...result, pageIndex: request.pageIndex, pageCount };
}

function conversationStatuses(
  lane: MemoryExtractionLane,
): readonly ConversationExtractionJob["status"][] {
  switch (lane) {
    case "waiting":
      return ["waiting_idle", "pending"];
    case "attention":
      return ["needs_attention"];
    case "running":
      return ["running"];
    case "completed":
      return ["completed"];
  }
}

function knowledgeStatuses(
  lane: MemoryExtractionLane,
): readonly KnowledgeExtractionJob["status"][] {
  switch (lane) {
    case "waiting":
      return ["pending"];
    case "attention":
      return ["needs_attention"];
    case "running":
      return ["running"];
    case "completed":
      return ["completed"];
  }
}

function compareJobs(left: PagedExtractionJob, right: PagedExtractionJob): number {
  return (
    right.job.updatedAt.localeCompare(left.job.updatedAt) ||
    jobTieBreaker(right).localeCompare(jobTieBreaker(left))
  );
}

function jobTieBreaker(entry: PagedExtractionJob): string {
  return `${entry.module}:${entry.job.id}`;
}

function taskCursor(task: DesktopMemoryExtractionTask): {
  readonly updatedAt: string;
  readonly tieBreaker: string;
} {
  return { updatedAt: task.updatedAt, tieBreaker: `${task.module}:${task.id}` };
}

function toDesktopTask(
  entry: PagedExtractionJob,
  missionTitles: ReadonlyMap<string, string>,
  executionTitles: ReadonlyMap<string, string>,
  resourceTitles: ReadonlyMap<string, string>,
): DesktopMemoryExtractionTask {
  const title =
    entry.module === "knowledge" || entry.module === "skill"
      ? resourceTitles.get(entry.job.rootRef.id)
      : entry.job.conversationRef.type === "pragma.mission"
        ? missionTitles.get(entry.job.conversationRef.id)
        : executionTitles.get(entry.job.conversationRef.id);
  return {
    module: entry.module,
    id: entry.job.id,
    revision: entry.job.revision,
    lane: entry.lane,
    ...(title === undefined ? {} : { title }),
    ...(entry.job.status === "needs_attention" && entry.job.lastErrorCode !== undefined
      ? { lastErrorCode: entry.job.lastErrorCode }
      : {}),
    updatedAt: entry.job.updatedAt,
  };
}
