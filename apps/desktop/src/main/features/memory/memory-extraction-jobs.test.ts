import {
  conversationExtractionJobId,
  groupConversationExtractionJobs,
  type MemoryJobPageInput,
  type EpisodicExtractionJob,
  type SemanticExtractionJob,
} from "@pragma/memory";
import type { KnowledgeExtractionJob, SkillLearningJob } from "@pragma/shared";
import { describe, expect, it, vi } from "vitest";

import type { ListDesktopMemoryExtractionJobs } from "../../../shared/contracts/index.ts";
import {
  getDesktopMemoryExtractionTaskDetail,
  listDesktopMemoryExtractionActiveTasks,
  listDesktopMemoryExtractionJobs,
} from "./memory-extraction-jobs.ts";

const FIRST_PAGES: ListDesktopMemoryExtractionJobs = {
  pages: {
    waiting: { pageIndex: 0 },
    attention: { pageIndex: 0 },
    running: { pageIndex: 0 },
    completed: { pageIndex: 0 },
  },
};

describe("unified memory extraction tasks", () => {
  it("shows one task with two independent outcomes and source names", async () => {
    const episode = {
      ...episodicJob(1, "2026-08-05T00:00:03.000Z"),
      completion: "retained" as const,
    };
    const fact = { ...semanticJob(1, "2026-08-05T00:00:02.000Z"), completion: "rejected" as const };
    const plane = planeFor([episode], [fact]);
    const board = await listDesktopMemoryExtractionJobs(plane, emptyTitleOptions(), FIRST_PAGES);
    expect(board.lanes.completed.totalTasks).toBe(1);
    expect(board.lanes.completed.tasks[0]).toMatchObject({
      module: "conversation",
      revision: 2,
      title: "Release mission",
      completion: "retained",
      results: { episodic: "retained", semantic: "rejected" },
    });
    expect(plane.episodicStore.listExtractionJobs).not.toHaveBeenCalled();
    expect(plane.knowledgeLearningStore.listJobs).not.toHaveBeenCalled();
    const detail = await getDesktopMemoryExtractionTaskDetail(
      plane,
      { ...emptyTitleOptions(), curator: { listRuns: async () => [] } },
      { module: "conversation", id: board.lanes.completed.tasks[0]!.id },
    );
    expect(detail.task.results).toEqual({ episodic: "retained", semantic: "rejected" });
  });

  it("groups before counting and paginating, with stable continuation cursors", async () => {
    const episodes = Array.from({ length: 12 }, (_, i) =>
      episodicJob(i, new Date(Date.UTC(2026, 7, 5, 0, 0, 12 - i)).toISOString()),
    );
    const facts = episodes.map((job, i) => ({
      ...semanticJob(i, job.updatedAt),
      completion: "rejected" as const,
    }));
    const plane = planeFor(episodes, facts);
    const first = await listDesktopMemoryExtractionJobs(plane, emptyTitleOptions(), FIRST_PAGES);
    expect(first.lanes.completed).toMatchObject({ totalTasks: 12, pageCount: 2, pageIndex: 0 });
    expect(first.lanes.completed.tasks).toHaveLength(10);
    const second = await listDesktopMemoryExtractionJobs(plane, emptyTitleOptions(), {
      pages: {
        ...FIRST_PAGES.pages,
        completed: { pageIndex: 1, cursor: first.lanes.completed.nextCursor! },
      },
    });
    expect(second.lanes.completed.tasks.map((task) => task.id)).toEqual(
      episodes
        .slice(10)
        .map((job) => conversationExtractionJobId(job.conversationRef, job.inputWatermark)),
    );
    expect(second.lanes.completed.nextCursor).toBeUndefined();
    const reset = await listDesktopMemoryExtractionJobs(plane, emptyTitleOptions(), {
      pages: {
        ...FIRST_PAGES.pages,
        completed: {
          pageIndex: 5,
          cursor: { updatedAt: "2026-01-01T00:00:00.000Z", tieBreaker: "missing" },
        },
      },
    });
    expect(reset.lanes.completed).toMatchObject({ totalTasks: 12, pageCount: 2, pageIndex: 0 });
  });

  it("filters task-detail lanes before pagination and keeps ties deterministic", async () => {
    const episodes = Array.from({ length: 75 }, (_, index) => ({
      ...episodicJob(index, "2026-08-05T00:00:03.000Z"),
      status: index % 3 === 0 ? ("pending" as const) : ("running" as const),
    }));
    const plane = planeFor(episodes);
    const options = emptyTitleOptions();
    const all = await listDesktopMemoryExtractionActiveTasks(plane, options, {
      lanes: ["running", "attention"],
    });
    const first = await listDesktopMemoryExtractionActiveTasks(plane, options, {
      lanes: ["running", "attention"],
      offset: 0,
      limit: 31,
    });
    const second = await listDesktopMemoryExtractionActiveTasks(plane, options, {
      lanes: ["running", "attention"],
      offset: 30,
      limit: 31,
    });
    expect(all).toHaveLength(50);
    expect(first).toHaveLength(31);
    expect(second).toHaveLength(20);
    expect([...first.slice(0, 30), ...second]).toEqual(all);
    expect(
      await listDesktopMemoryExtractionActiveTasks(plane, options, { offset: 75, limit: 31 }),
    ).toEqual([]);
  });

  it("preserves partial success and puts the shared task in its actionable lane", async () => {
    const episode = {
      ...episodicJob(1, "2026-08-05T00:00:01.000Z"),
      completion: "retained" as const,
    };
    const fact = {
      ...semanticJob(1, "2026-08-05T00:00:02.000Z"),
      status: "needs_attention" as const,
      lastErrorCode: "extractor_evidence_ref_invalid",
      failureClass: "transient-exhausted" as const,
    };
    const plane = planeFor([episode], [fact]);
    const board = await listDesktopMemoryExtractionJobs(plane, emptyTitleOptions(), FIRST_PAGES);
    expect(board.lanes.completed.totalTasks).toBe(0);
    expect(board.lanes.attention.tasks[0]).toMatchObject({
      module: "conversation",
      results: { episodic: "retained", semantic: "failed" },
      problem: { kind: "invalid_output", technicalCode: "extractor_evidence_ref_invalid" },
    });
    expect(await listDesktopMemoryExtractionActiveTasks(plane, emptyTitleOptions())).toHaveLength(
      1,
    );
  });

  it("keeps different source watermarks distinct and interleaves knowledge tasks", async () => {
    const episode = episodicJob(1, "2026-08-05T00:00:03.000Z");
    const fact = semanticJob(2, "2026-08-05T00:00:02.000Z");
    const knowledge = knowledgeJob(1, "2026-08-05T00:00:01.000Z");
    const options = {
      ...emptyTitleOptions(),
      project: {
        get: async () => ({
          resources: [{ metadata: { id: "resource-1", name: "Knowledge source" } }],
        }),
      },
    } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[1];
    const board = await listDesktopMemoryExtractionJobs(
      planeFor([episode], [fact], [knowledge]),
      options,
      FIRST_PAGES,
    );
    expect(board.lanes.completed.tasks.map((task) => [task.module, task.title])).toEqual([
      ["conversation", "Release mission"],
      ["conversation", "Release mission"],
      ["knowledge", "Knowledge source"],
    ]);
  });

  it("retains built-in names and Skill rejections without technical IDs in user-facing names", async () => {
    const knowledge = knowledgeJob(1, "2026-08-05T00:00:01.000Z");
    const skill: SkillLearningJob = {
      schemaVersion: "pragma.memory-skill-job/v2",
      id: "skill-job",
      revision: 1,
      rootRef: knowledge.rootRef,
      sourceDigest: "a".repeat(64),
      status: "completed",
      attempts: 1,
      completion: "rejected",
      createdAt: knowledge.updatedAt,
      updatedAt: knowledge.updatedAt,
    };
    const options = {
      ...emptyTitleOptions(),
      project: { get: async () => ({ resources: [] }) },
      systemExperts: { list: () => [{ id: knowledge.rootRef.id, name: "Pragma" }] },
      curator: { listRuns: async () => [] },
    } as unknown as Parameters<typeof getDesktopMemoryExtractionTaskDetail>[1];
    const plane = planeFor([], [], [knowledge], [skill]);
    const board = await listDesktopMemoryExtractionJobs(plane, options, FIRST_PAGES);
    expect(board.lanes.completed.tasks.map((task) => task.title)).toEqual(["Pragma", "Pragma"]);
    expect(board.lanes.completed.tasks.find((task) => task.module === "skill")?.completion).toBe(
      "rejected",
    );
    expect(
      (
        await getDesktopMemoryExtractionTaskDetail(plane, options, {
          module: "knowledge",
          id: knowledge.id,
        })
      ).task.title,
    ).toBe("Pragma");
  });
  it("returns the actionable failure history and read-only run records for a task", async () => {
    const diagnostic = {
      schemaVersion: "pragma.memory-extraction-failure/v1" as const,
      code: "rate_limit_exceeded",
      message: "429 rate limit exceeded",
      phase: "curator_run" as const,
      failedAt: "2026-08-05T00:00:03.000Z",
      durationMs: 30_000,
      runtime: { runtimeId: "runtime-a", providerId: "provider-a", modelId: "model-a" },
      transport: { httpStatus: 429 },
    };
    const skill: SkillLearningJob = {
      schemaVersion: "pragma.memory-skill-job/v2",
      id: "skill-job",
      revision: 4,
      rootRef: { type: "pragma.expert", id: "resource-1" },
      sourceDigest: "a".repeat(64),
      status: "needs_attention",
      attempts: 3,
      lastErrorCode: diagnostic.code,
      lastErrorMessage: diagnostic.message,
      lastFailure: diagnostic,
      failureClass: "transient-exhausted",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:03.000Z",
    };
    const failureAttempt = {
      schemaVersion: "pragma.memory-extraction-failure-attempt/v1" as const,
      id: "attempt-1",
      jobId: skill.id,
      jobRevision: 3,
      attempt: 3,
      diagnostic,
    };

    const detail = await getDesktopMemoryExtractionTaskDetail(
      {
        skillLearningStore: {
          listJobs: vi.fn(async () => [skill]),
          getJob: vi.fn(async () => skill),
          listFailureAttempts: vi.fn(async () => [failureAttempt]),
        },
      } as unknown as Parameters<typeof getDesktopMemoryExtractionTaskDetail>[0],
      {
        missions: emptyTitleOptions().missions,
        project: {
          get: vi.fn(async () => ({
            resources: [{ metadata: { id: "resource-1", name: "Research team" } }],
          })),
        },
        curator: { listRuns: vi.fn(async () => []) },
      } as unknown as Parameters<typeof getDesktopMemoryExtractionTaskDetail>[1],
      { module: "skill", id: skill.id },
    );

    expect(detail).toMatchObject({
      task: { module: "skill", lane: "attention", title: "Research team" },
      lastErrorMessage: "429 rate limit exceeded",
      lastFailure: { transport: { httpStatus: 429 } },
      attempts: [{ diagnostic: { code: "rate_limit_exceeded" } }],
      runs: [],
    });
  });
});

function planeFor(
  episodes: readonly EpisodicExtractionJob[] = [],
  facts: readonly SemanticExtractionJob[] = [],
  knowledge: readonly KnowledgeExtractionJob[] = [],
  skills: readonly SkillLearningJob[] = [],
) {
  const page = <T>(
    items: readonly T[],
    input: MemoryJobPageInput<string>,
    prefix: string,
    fields: (item: T) => { id: string; updatedAt: string; status: string },
  ) => {
    const all = items
      .filter((item) => input.statuses.includes(fields(item).status))
      .toSorted(
        (a, b) =>
          fields(b).updatedAt.localeCompare(fields(a).updatedAt) ||
          fields(b).id.localeCompare(fields(a).id),
      );
    return {
      total: all.length,
      jobs: all
        .filter(
          (item) =>
            input.before === undefined ||
            fields(item).updatedAt < input.before.updatedAt ||
            (fields(item).updatedAt === input.before.updatedAt &&
              `${prefix}:${fields(item).id}` < input.before.tieBreaker),
        )
        .slice(0, input.limit),
    };
  };
  return {
    conversationExtractionJobs: {
      getTask: vi.fn(async (id: string) =>
        groupConversationExtractionJobs(episodes, facts).find((item) => item.job.id === id),
      ),
      listJobsPage: vi.fn(async (input: MemoryJobPageInput<string>) =>
        page(groupConversationExtractionJobs(episodes, facts), input, "conversation", (item) => ({
          ...item.job,
          status: item.lane,
        })),
      ),
    },
    episodicStore: {
      listExtractionJobs: vi.fn(async () => episodes),
      getExtractionJob: vi.fn(async (id: string) => episodes.find((job) => job.id === id)),
      listFailureAttempts: async () => [],
    },
    semanticStore: {
      listExtractionJobs: vi.fn(async () => facts),
      getExtractionJob: vi.fn(async (id: string) => facts.find((job) => job.id === id)),
      listFailureAttempts: async () => [],
    },
    knowledgeLearningStore: {
      listJobs: vi.fn(async () => knowledge),
      getJob: vi.fn(async (id: string) => knowledge.find((job) => job.id === id)),
      listJobsPage: vi.fn(async (input: MemoryJobPageInput<string>) =>
        page(knowledge, input, "knowledge", (job) => job),
      ),
      listFailureAttempts: async () => [],
    },
    skillLearningStore: {
      listJobs: vi.fn(async () => skills),
      getJob: vi.fn(async (id: string) => skills.find((job) => job.id === id)),
      listJobsPage: vi.fn(async (input: MemoryJobPageInput<string>) =>
        page(skills, input, "skill", (job) => job),
      ),
      listFailureAttempts: async () => [],
    },
  } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[0];
}
function emptyTitleOptions(): Parameters<typeof listDesktopMemoryExtractionJobs>[1] {
  return {
    missions: {
      get: vi.fn(async (id: string) => ({ id, title: "Release mission" })),
      resolveExecutionTitles: vi.fn(async () => new Map<string, string>()),
    },
    project: { get: vi.fn() },
  } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[1];
}

function episodicJob(index: number, updatedAt: string): EpisodicExtractionJob {
  return {
    schemaVersion: "pragma.memory-extraction-job/v4",
    id: `job-${String(index).padStart(2, "0")}`,
    revision: 1,
    conversationRef: { type: "pragma.mission", id: "mission-1" },
    sourceExecutionIds: ["execution-1"],
    sourceUpdatedAt: updatedAt,
    inputWatermark: `watermark-${index}`,
    executionId: "execution-1",
    terminalMessageId: `message-${index}`,
    status: "completed",
    attempts: 0,
    totalAttempts: 0,
    updatedAt,
  };
}

function semanticJob(index: number, updatedAt: string): SemanticExtractionJob {
  return {
    ...episodicJob(index, updatedAt),
    schemaVersion: "pragma.memory-semantic-job/v4",
  };
}

function knowledgeJob(index: number, updatedAt: string): KnowledgeExtractionJob {
  return {
    schemaVersion: "pragma.memory-knowledge-job/v3",
    id: `knowledge-${String(index).padStart(2, "0")}`,
    revision: 1,
    rootRef: { type: "pragma.context-store", id: "resource-1" },
    sourceDigest: "a".repeat(64),
    firstFactAt: updatedAt,
    lastFactAt: updatedAt,
    eligibleAt: updatedAt,
    deadlineAt: updatedAt,
    status: "completed",
    attempts: 0,
    createdAt: updatedAt,
    updatedAt,
  };
}
