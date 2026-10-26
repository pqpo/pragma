import {
  groupConversationExtractionJobs,
  type EpisodicExtractionJob,
  type SemanticExtractionJob,
} from "@pragma/memory";
import type { KnowledgeExtractionJob } from "@pragma/shared";
import type { SkillLearningJob } from "@pragma/shared";

import {
  DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE,
  ListDesktopMemoryExtractionActiveTasksSchema,
  type ListDesktopMemoryExtractionActiveTasks,
  DesktopMemoryExtractionBoardSchema,
  type DesktopMemoryExtractionBoard,
  type DesktopMemoryExtractionTask,
  type ListDesktopMemoryExtractionJobs,
  DesktopMemoryExtractionTaskDetailSchema,
  DesktopMemoryExtractionActiveTaskListSchema,
  type DesktopMemoryExtractionTaskDetail,
  type DesktopMemoryExtractionTaskRef,
} from "../../../shared/contracts/index.ts";
import type { MissionStore } from "@pragma/local-host";
import type { PragmaProjectStore } from "@pragma/local-host/deployment";
import { classifyDesktopMemoryProblem } from "../../../shared/memory-problem.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { DesktopMemoryCurator } from "./memory-curator.ts";

const MEMORY_EXTRACTION_LANES = ["waiting", "attention", "running", "completed"] as const;
type MemoryExtractionLane = (typeof MEMORY_EXTRACTION_LANES)[number];
type ConversationExtractionJob = EpisodicExtractionJob | SemanticExtractionJob;
type PagedExtractionJob =
  | {
      readonly module: "conversation";
      readonly lane: MemoryExtractionLane;
      readonly job: ConversationExtractionJob;
      readonly members: readonly {
        module: "episodic" | "semantic";
        job: ConversationExtractionJob;
      }[];
    }
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

interface ExtractionTaskTitleOptions {
  readonly missions: Pick<MissionStore, "get" | "resolveExecutionTitles">;
  readonly project: Pick<PragmaProjectStore, "get">;
  readonly systemExperts?: { list(): readonly { readonly id: string; readonly name: string }[] };
}

export async function listDesktopMemoryExtractionJobs(
  plane: Pick<
    DesktopMemoryPlane,
    | "episodicStore"
    | "semanticStore"
    | "knowledgeLearningStore"
    | "skillLearningStore"
    | "conversationExtractionJobs"
  >,
  options: ExtractionTaskTitleOptions,
  input: ListDesktopMemoryExtractionJobs,
): Promise<DesktopMemoryExtractionBoard> {
  const loadedPages = await Promise.all(
    MEMORY_EXTRACTION_LANES.map((lane) => loadLanePage(plane, lane, input.pages[lane])),
  );
  const jobs = loadedPages.flatMap((page) => page.jobs);
  const { missionTitles, executionTitles, resourceTitles } = await loadTaskTitles(jobs, options);

  return DesktopMemoryExtractionBoardSchema.parse({
    lanes: Object.fromEntries(
      MEMORY_EXTRACTION_LANES.map((lane, index) => {
        const page = loadedPages[index]!;
        const tasks = page.jobs.map((entry) =>
          toDesktopTask(entry, missionTitles, executionTitles, resourceTitles, plane),
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

export async function listDesktopMemoryExtractionActiveTasks(
  plane: Pick<
    DesktopMemoryPlane,
    "episodicStore" | "semanticStore" | "knowledgeLearningStore" | "skillLearningStore"
  >,
  options: ExtractionTaskTitleOptions,
  input: ListDesktopMemoryExtractionActiveTasks = {},
): Promise<readonly DesktopMemoryExtractionTask[]> {
  const page = ListDesktopMemoryExtractionActiveTasksSchema.parse(input);
  const [episodic, semantic, knowledge, skill] = await Promise.all([
    plane.episodicStore.listExtractionJobs(),
    plane.semanticStore.listExtractionJobs(),
    plane.knowledgeLearningStore.listJobs(),
    plane.skillLearningStore.listJobs(),
  ]);
  const jobs: PagedExtractionJob[] = [
    ...groupConversationExtractionJobs(episodic, semantic),
    ...knowledge.map((job) => ({
      module: "knowledge" as const,
      lane: laneForStatus(job.status),
      job,
    })),
    ...skill.map((job) => ({ module: "skill" as const, lane: laneForStatus(job.status), job })),
  ]
    .filter((entry) => entry.lane !== "completed" && page.lanes.includes(entry.lane))
    .toSorted(compareJobs)
    .slice(page.offset, page.offset + page.limit);
  const { missionTitles, executionTitles, resourceTitles } = await loadTaskTitles(jobs, options);
  return DesktopMemoryExtractionActiveTaskListSchema.parse(
    jobs.map((entry) =>
      toDesktopTask(entry, missionTitles, executionTitles, resourceTitles, plane),
    ),
  );
}

async function loadTaskTitles(
  jobs: readonly PagedExtractionJob[],
  options: ExtractionTaskTitleOptions,
) {
  const conversationJobs = jobs.filter(
    (
      entry,
    ): entry is Extract<PagedExtractionJob, { module: "episodic" | "semantic" | "conversation" }> =>
      entry.module === "episodic" || entry.module === "semantic" || entry.module === "conversation",
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
  const resourceTitles = new Map([
    ...(project?.resources.map(
      (resource) => [resource.metadata.id, resource.metadata.name] as const,
    ) ?? []),
    ...(options.systemExperts?.list().map((expert) => [expert.id, expert.name] as const) ?? []),
  ]);
  return { missionTitles, executionTitles, resourceTitles };
}

export async function getDesktopMemoryExtractionTaskDetail(
  plane: Pick<
    DesktopMemoryPlane,
    | "episodicStore"
    | "semanticStore"
    | "knowledgeLearningStore"
    | "skillLearningStore"
    | "conversationExtractionJobs"
  >,
  options: ExtractionTaskTitleOptions & {
    readonly curator: Pick<DesktopMemoryCurator, "listRuns">;
  },
  input: DesktopMemoryExtractionTaskRef,
): Promise<DesktopMemoryExtractionTaskDetail> {
  if (input.module === "conversation") {
    const entry = await plane.conversationExtractionJobs.getTask(input.id);
    if (entry === undefined) throw new Error("memory_extraction_job_not_found");
    const details = await Promise.all(
      entry.members.map(({ module, job }) =>
        getDesktopMemoryExtractionTaskDetail(plane, options, { module, id: job.id }),
      ),
    );
    const { missionTitles, executionTitles, resourceTitles } = await loadTaskTitles(
      [entry],
      options,
    );
    const runs = [
      ...(await options.curator.listRuns({ module: "conversation", jobId: input.id })),
      ...details.flatMap((detail) => detail.runs),
    ];
    const problem = details.find((detail) => detail.task.lane === "attention");
    return DesktopMemoryExtractionTaskDetailSchema.parse({
      task: toDesktopTask(entry, missionTitles, executionTitles, resourceTitles, plane),
      lastErrorMessage: problem?.lastErrorMessage,
      lastFailure: problem?.lastFailure,
      attempts: details.flatMap((detail) => detail.attempts).slice(-20),
      runs: runs
        .filter(
          (run, index) => runs.findIndex((candidate) => candidate.runId === run.runId) === index,
        )
        .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 20),
    });
  }
  const job =
    input.module === "episodic"
      ? await plane.episodicStore.getExtractionJob(input.id)
      : input.module === "semantic"
        ? await plane.semanticStore.getExtractionJob(input.id)
        : input.module === "knowledge"
          ? await plane.knowledgeLearningStore.getJob(input.id)
          : await plane.skillLearningStore.getJob(input.id);
  if (job === undefined) throw new Error("memory_extraction_job_not_found");

  const entry = {
    module: input.module,
    lane: laneForStatus(job.status),
    job,
  } as PagedExtractionJob;
  const missionTitles = new Map<string, string>();
  const executionTitles = new Map<string, string>();
  const resourceTitles = new Map<string, string>();
  if (
    entry.module === "episodic" ||
    entry.module === "semantic" ||
    entry.module === "conversation"
  ) {
    if (entry.job.conversationRef.type === "pragma.mission") {
      const mission = await options.missions
        .get(entry.job.conversationRef.id)
        .catch(() => undefined);
      if (mission !== undefined) missionTitles.set(mission.id, mission.title);
    } else {
      const titles = await options.missions.resolveExecutionTitles([entry.job.conversationRef.id]);
      for (const [id, title] of titles) executionTitles.set(id, title);
    }
  } else {
    const project = await options.project.get();
    for (const resource of project.resources) {
      resourceTitles.set(resource.metadata.id, resource.metadata.name);
    }
    for (const expert of options.systemExperts?.list() ?? []) {
      resourceTitles.set(expert.id, expert.name);
    }
  }
  const [attempts, runs] = await Promise.all([
    input.module === "episodic"
      ? plane.episodicStore.listFailureAttempts(input.id)
      : input.module === "semantic"
        ? plane.semanticStore.listFailureAttempts(input.id)
        : input.module === "knowledge"
          ? plane.knowledgeLearningStore.listFailureAttempts(input.id)
          : plane.skillLearningStore.listFailureAttempts(input.id),
    options.curator.listRuns({ module: input.module, jobId: input.id }),
  ]);
  return DesktopMemoryExtractionTaskDetailSchema.parse({
    task: toDesktopTask(entry, missionTitles, executionTitles, resourceTitles, plane),
    ...(job.lastErrorMessage === undefined ? {} : { lastErrorMessage: job.lastErrorMessage }),
    ...(job.lastFailure === undefined ? {} : { lastFailure: job.lastFailure }),
    attempts,
    runs,
  });
}

function laneForStatus(status: PagedExtractionJob["job"]["status"]): MemoryExtractionLane {
  switch (status) {
    case "waiting_idle":
    case "pending":
      return "waiting";
    case "needs_attention":
      return "attention";
    case "running":
      return "running";
    case "completed":
      return "completed";
    default:
      throw new Error(`memory_extraction_job_status_invalid:${String(status)}`);
  }
}

async function loadLanePage(
  plane: Pick<
    DesktopMemoryPlane,
    "conversationExtractionJobs" | "knowledgeLearningStore" | "skillLearningStore"
  >,
  lane: MemoryExtractionLane,
  request: ListDesktopMemoryExtractionJobs["pages"][MemoryExtractionLane],
): Promise<LoadedLanePage> {
  const query = async (cursor: typeof request.cursor) => {
    const common = {
      limit: DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE,
      ...(cursor === undefined ? {} : { before: cursor }),
    };
    const statuses = [
      lane === "waiting" ? "pending" : lane === "attention" ? "needs_attention" : lane,
    ] as const;
    const [conversation, knowledge, skill] = await Promise.all([
      plane.conversationExtractionJobs.listJobsPage({
        ...common,
        statuses: [lane],
        sortKeyPrefix: "conversation",
      }),
      plane.knowledgeLearningStore.listJobsPage({
        ...common,
        statuses,
        sortKeyPrefix: "knowledge",
      }),
      plane.skillLearningStore.listJobsPage({ ...common, statuses, sortKeyPrefix: "skill" }),
    ]);
    const jobs: PagedExtractionJob[] = [
      ...conversation.jobs,
      ...knowledge.jobs.map((job) => ({ module: "knowledge" as const, lane, job })),
      ...skill.jobs.map((job) => ({ module: "skill" as const, lane, job })),
    ];
    return {
      jobs: jobs.toSorted(compareJobs).slice(0, DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE),
      totalTasks: conversation.total + knowledge.total + skill.total,
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

export { groupConversationExtractionJobs } from "@pragma/memory";

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
  plane: Pick<DesktopMemoryPlane, "knowledgeLearningStore" | "skillLearningStore">,
): DesktopMemoryExtractionTask {
  const presentation =
    entry.module === "knowledge"
      ? plane.knowledgeLearningStore.getPresentation(entry.job)
      : entry.module === "skill"
        ? plane.skillLearningStore.getPresentation(entry.job)
        : undefined;
  const decision =
    entry.module === "knowledge"
      ? plane.knowledgeLearningStore.getDecision?.(entry.job)
      : entry.module === "skill"
        ? plane.skillLearningStore.getDecision?.(entry.job)
        : undefined;
  const title =
    entry.module === "knowledge" || entry.module === "skill"
      ? presentation?.titles[0]
      : entry.job.conversationRef.type === "pragma.mission"
        ? missionTitles.get(entry.job.conversationRef.id)
        : executionTitles.get(entry.job.conversationRef.id);
  return {
    module: entry.module,
    id: entry.job.id,
    revision: entry.job.revision,
    lane: entry.lane,
    ...(title === undefined ? {} : { title }),
    ...(entry.module === "knowledge" || entry.module === "skill"
      ? {
          sourceName: resourceTitles.get(entry.job.rootRef.id),
          createdAt: entry.job.createdAt,
          ...(presentation === undefined ? {} : { topicCount: presentation.topicCount }),
          ...(decision === undefined
            ? {}
            : {
                learningDecision: {
                  outcome: decision.outcome,
                  reason: decision.reason,
                  targets: decision.targets,
                },
              }),
        }
      : { createdAt: entry.job.sourceUpdatedAt }),
    ...(entry.job.status === "completed" && entry.job.completion !== undefined
      ? { completion: entry.job.completion }
      : {}),
    ...(entry.job.status === "needs_attention" && entry.job.lastErrorCode !== undefined
      ? {
          problem: classifyDesktopMemoryProblem(entry.job.lastErrorCode, entry.job.failureClass),
        }
      : {}),
    ...(entry.lane === "waiting" && entry.job.lastErrorCode !== undefined
      ? {
          recovery:
            entry.job.lastErrorCode === "memory_curator_timeout"
              ? ("waiting_execution" as const)
              : ("waiting_retry" as const),
          retryAt: entry.job.retryAt,
        }
      : {}),
    updatedAt: entry.job.updatedAt,
    ...(entry.module === "conversation"
      ? {
          results: Object.fromEntries(
            entry.members.map(({ module, job }) => [
              module,
              job.status === "completed"
                ? (job.completion ?? "rejected")
                : job.status === "needs_attention"
                  ? "failed"
                  : "pending",
            ]),
          ),
        }
      : {}),
  };
}
