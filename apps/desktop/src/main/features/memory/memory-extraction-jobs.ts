import {
  conversationExtractionJobId,
  type EpisodicExtractionJob,
  type SemanticExtractionJob,
} from "@pragma/memory";
import type { KnowledgeExtractionJob } from "@pragma/shared";
import type { SkillLearningJob } from "@pragma/shared";

import {
  DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE,
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
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
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
    "episodicStore" | "semanticStore" | "knowledgeLearningStore" | "skillLearningStore"
  >,
  options: ExtractionTaskTitleOptions,
  input: ListDesktopMemoryExtractionJobs,
): Promise<DesktopMemoryExtractionBoard> {
  const snapshot = await loadAllExtractionJobs(plane);
  const loadedPages = MEMORY_EXTRACTION_LANES.map((lane) =>
    loadLanePage(snapshot, lane, input.pages[lane]),
  );
  const jobs = loadedPages.flatMap((page) => page.jobs);
  const { missionTitles, executionTitles, resourceTitles } = await loadTaskTitles(jobs, options);

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

export async function listDesktopMemoryExtractionActiveTasks(
  plane: Pick<
    DesktopMemoryPlane,
    "episodicStore" | "semanticStore" | "knowledgeLearningStore" | "skillLearningStore"
  >,
  options: ExtractionTaskTitleOptions,
): Promise<readonly DesktopMemoryExtractionTask[]> {
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
    .filter((entry) => entry.lane !== "completed")
    .toSorted(compareJobs);
  const { missionTitles, executionTitles, resourceTitles } = await loadTaskTitles(jobs, options);
  return DesktopMemoryExtractionActiveTaskListSchema.parse(
    jobs.map((entry) => toDesktopTask(entry, missionTitles, executionTitles, resourceTitles)),
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
    "episodicStore" | "semanticStore" | "knowledgeLearningStore" | "skillLearningStore"
  >,
  options: ExtractionTaskTitleOptions & {
    readonly curator: Pick<DesktopMemoryCurator, "listRuns">;
  },
  input: DesktopMemoryExtractionTaskRef,
): Promise<DesktopMemoryExtractionTaskDetail> {
  if (input.module === "conversation") {
    const [episodic, semantic] = await Promise.all([
      plane.episodicStore.listExtractionJobs(),
      plane.semanticStore.listExtractionJobs(),
    ]);
    const entry = groupConversationExtractionJobs(episodic, semantic).find(
      ({ job }) => job.id === input.id,
    );
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
      task: toDesktopTask(entry, missionTitles, executionTitles, resourceTitles),
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
  const jobs =
    input.module === "episodic"
      ? await plane.episodicStore.listExtractionJobs()
      : input.module === "semantic"
        ? await plane.semanticStore.listExtractionJobs()
        : input.module === "knowledge"
          ? await plane.knowledgeLearningStore.listJobs()
          : await plane.skillLearningStore.listJobs();
  const job = jobs.find((candidate) => candidate.id === input.id);
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
    task: toDesktopTask(entry, missionTitles, executionTitles, resourceTitles),
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

async function loadAllExtractionJobs(
  plane: Pick<DesktopMemoryPlane, "episodicStore" | "semanticStore" | "knowledgeLearningStore"> &
    Partial<Pick<DesktopMemoryPlane, "skillLearningStore">>,
): Promise<PagedExtractionJob[]> {
  const [episodic, semantic, knowledge, skill] = await Promise.all([
    plane.episodicStore.listExtractionJobs(),
    plane.semanticStore.listExtractionJobs(),
    plane.knowledgeLearningStore.listJobs(),
    plane.skillLearningStore?.listJobs() ?? Promise.resolve([]),
  ]);
  return [
    ...groupConversationExtractionJobs(episodic, semantic),
    ...knowledge.map((job) => ({
      module: "knowledge" as const,
      lane: laneForStatus(job.status),
      job,
    })),
    ...skill.map((job) => ({ module: "skill" as const, lane: laneForStatus(job.status), job })),
  ];
}

function loadLanePage(
  snapshot: readonly PagedExtractionJob[],
  lane: MemoryExtractionLane,
  request: ListDesktopMemoryExtractionJobs["pages"][MemoryExtractionLane],
): LoadedLanePage {
  const jobs = snapshot.filter((entry) => entry.lane === lane).toSorted(compareJobs);
  const pageCount = Math.max(1, Math.ceil(jobs.length / DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE));
  const before = request.cursor;
  let remaining =
    before === undefined
      ? jobs
      : jobs.filter(
          (entry) =>
            entry.job.updatedAt < before.updatedAt ||
            (entry.job.updatedAt === before.updatedAt && jobTieBreaker(entry) < before.tieBreaker),
        );
  const reset = request.pageIndex >= pageCount || (request.pageIndex > 0 && remaining.length === 0);
  if (reset) remaining = jobs;
  return {
    jobs: remaining.slice(0, DESKTOP_MEMORY_EXTRACTION_PAGE_SIZE),
    totalTasks: jobs.length,
    pageCount,
    pageIndex: reset ? 0 : request.pageIndex,
  };
}

export function groupConversationExtractionJobs(
  episodic: readonly EpisodicExtractionJob[],
  semantic: readonly SemanticExtractionJob[],
): Extract<PagedExtractionJob, { module: "conversation" }>[] {
  const groups = new Map<
    string,
    { module: "episodic" | "semantic"; job: ConversationExtractionJob }[]
  >();
  for (const [module, jobs] of [
    ["episodic", episodic],
    ["semantic", semantic],
  ] as const) {
    for (const job of jobs) {
      if (job.status === "expired") continue;
      const id = conversationExtractionJobId(job.conversationRef, job.inputWatermark);
      const members = groups.get(id) ?? [];
      members.push({ module, job });
      groups.set(id, members);
    }
  }
  const rank = { completed: 0, waiting: 1, running: 3, attention: 2 };
  return [...groups].map(([id, members]) => {
    const representative = members.toSorted(
      (a, b) => rank[laneForStatus(b.job.status)] - rank[laneForStatus(a.job.status)],
    )[0]!.job;
    const lane = laneForStatus(representative.status);
    return {
      module: "conversation",
      lane,
      members,
      job: {
        ...representative,
        id,
        revision: members.reduce((total, member) => total + member.job.revision, 0),
        updatedAt: members
          .map(({ job }) => job.updatedAt)
          .toSorted()
          .at(-1)!,
        ...(lane === "completed"
          ? {
              completion: members.some(({ job }) => job.completion === "retained")
                ? "retained"
                : "rejected",
            }
          : {}),
      },
    };
  });
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
    ...(entry.job.status === "completed" && entry.job.completion !== undefined
      ? { completion: entry.job.completion }
      : {}),
    ...(entry.job.status === "needs_attention" && entry.job.lastErrorCode !== undefined
      ? {
          problem: classifyDesktopMemoryProblem(entry.job.lastErrorCode, entry.job.failureClass),
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
