import type { EpisodicExtractionJob, SemanticExtractionJob } from "@pragma/memory";
import type { KnowledgeExtractionJob, SkillLearningJob } from "@pragma/shared";
import { describe, expect, it, vi } from "vitest";

import type { ListDesktopMemoryExtractionJobs } from "../../../shared/contracts/index.ts";
import { listDesktopMemoryExtractionJobs } from "./memory-extraction-jobs.ts";

const FIRST_PAGES: ListDesktopMemoryExtractionJobs = {
  pages: {
    waiting: { pageIndex: 0 },
    attention: { pageIndex: 0 },
    running: { pageIndex: 0 },
    completed: { pageIndex: 0 },
  },
};

describe("listDesktopMemoryExtractionJobs", () => {
  it("queries and returns only the current cursor page for every lane", async () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      episodicJob(index, new Date(Date.UTC(2026, 7, 5, 0, 0, 11 - index)).toISOString()),
    );
    const listExtractionJobsPage = vi.fn(
      (input: {
        readonly statuses: readonly string[];
        readonly limit: number;
        readonly before?: { readonly tieBreaker: string } | undefined;
      }) => {
        if (!input.statuses.includes("completed")) return Promise.resolve({ jobs: [], total: 0 });
        return Promise.resolve({
          jobs: input.before === undefined ? jobs.slice(0, 10) : jobs.slice(10),
          total: jobs.length,
        });
      },
    );
    const semanticPage = vi.fn(async (input: { readonly statuses: readonly string[] }) => {
      void input;
      return { jobs: [], total: 0 };
    });
    const knowledgePage = vi.fn(async (input: { readonly statuses: readonly string[] }) => {
      void input;
      return { jobs: [], total: 0 };
    });
    const plane = {
      episodicStore: { listExtractionJobsPage },
      semanticStore: { listExtractionJobsPage: semanticPage },
      knowledgeLearningStore: { listJobsPage: knowledgePage },
    } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[0];
    const options = {
      missions: {
        get: vi.fn(async (id: string) => ({ id, title: "Release mission" })),
        resolveExecutionTitles: vi.fn(async () => new Map<string, string>()),
      },
      project: { get: vi.fn() },
    } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[1];

    const first = await listDesktopMemoryExtractionJobs(plane, options, FIRST_PAGES);
    expect(first.lanes.completed.tasks).toHaveLength(10);
    expect(first.lanes.completed.totalTasks).toBe(12);
    expect(first.lanes.completed.pageCount).toBe(2);
    expect(first.lanes.completed.tasks[0]?.id).toBe("job-00");
    expect(first.lanes.completed.nextCursor).toEqual({
      updatedAt: jobs[9]!.updatedAt,
      tieBreaker: "episodic:job-09",
    });
    expect(listExtractionJobsPage).toHaveBeenCalledTimes(4);
    expect(listExtractionJobsPage.mock.calls.every(([input]) => input.limit === 10)).toBe(true);
    expect(listExtractionJobsPage.mock.calls.map(([input]) => input.statuses)).toEqual([
      ["waiting_idle", "pending"],
      ["needs_attention"],
      ["running"],
      ["completed"],
    ]);
    expect(knowledgePage.mock.calls.map(([input]) => input.statuses)).toEqual([
      ["pending"],
      ["needs_attention"],
      ["running"],
      ["completed"],
    ]);

    const second = await listDesktopMemoryExtractionJobs(plane, options, {
      pages: {
        ...FIRST_PAGES.pages,
        completed: { pageIndex: 1, cursor: first.lanes.completed.nextCursor! },
      },
    });
    expect(second.lanes.completed.tasks.map((task) => task.id)).toEqual(["job-10", "job-11"]);
    expect(second.lanes.completed.pageIndex).toBe(1);
    expect(second.lanes.completed.nextCursor).toBeUndefined();
  });

  it("recomputes the page count when an invalid cursor page falls back to the first page", async () => {
    const firstPageJobs = Array.from({ length: 10 }, (_, index) =>
      episodicJob(index, new Date(Date.UTC(2026, 7, 5, 0, 0, 20 - index)).toISOString()),
    );
    const episodicPage = vi.fn(
      async (input: { readonly statuses: readonly string[]; readonly before?: unknown }) =>
        input.statuses.includes("completed")
          ? input.before === undefined
            ? { jobs: firstPageJobs, total: 25 }
            : { jobs: [], total: 11 }
          : { jobs: [], total: 0 },
    );
    const emptyPage = vi.fn(async () => ({ jobs: [], total: 0 }));

    const board = await listDesktopMemoryExtractionJobs(
      {
        episodicStore: { listExtractionJobsPage: episodicPage },
        semanticStore: { listExtractionJobsPage: emptyPage },
        knowledgeLearningStore: { listJobsPage: emptyPage },
      } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[0],
      emptyTitleOptions(),
      {
        pages: {
          ...FIRST_PAGES.pages,
          completed: {
            pageIndex: 5,
            cursor: {
              updatedAt: "2026-08-04T00:00:00.000Z",
              tieBreaker: "episodic:missing",
            },
          },
        },
      },
    );

    expect(board.lanes.completed.pageIndex).toBe(0);
    expect(board.lanes.completed.pageCount).toBe(3);
    expect(board.lanes.completed.totalTasks).toBe(25);
    expect(board.lanes.completed.tasks).toHaveLength(10);
  });

  it("merges mixed-module pages in stable global update order", async () => {
    const episodic = episodicJob(1, "2026-08-05T00:00:03.000Z");
    const semantic = semanticJob(1, "2026-08-05T00:00:02.000Z");
    const knowledge = knowledgeJob(1, "2026-08-05T00:00:01.000Z");
    const byCompleted = <T>(jobs: readonly T[]) =>
      vi.fn(async (input: { readonly statuses: readonly string[] }) =>
        input.statuses.includes("completed")
          ? { jobs, total: jobs.length }
          : { jobs: [] as readonly T[], total: 0 },
      );

    const board = await listDesktopMemoryExtractionJobs(
      {
        episodicStore: { listExtractionJobsPage: byCompleted([episodic]) },
        semanticStore: { listExtractionJobsPage: byCompleted([semantic]) },
        knowledgeLearningStore: { listJobsPage: byCompleted([knowledge]) },
      } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[0],
      {
        ...emptyTitleOptions(),
        project: {
          get: vi.fn(async () => ({
            resources: [{ metadata: { id: "resource-1", name: "Knowledge source" } }],
          })),
        },
      } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[1],
      FIRST_PAGES,
    );

    expect(board.lanes.completed.tasks.map((task) => task.module)).toEqual([
      "episodic",
      "semantic",
      "knowledge",
    ]);
    expect(board.lanes.completed.tasks.map((task) => task.title)).toEqual([
      "Release mission",
      "Release mission",
      "Knowledge source",
    ]);
  });

  it("exposes a completed Skill rejection without an error code", async () => {
    const completed = <T>(jobs: readonly T[]) =>
      vi.fn(async (input: { readonly statuses: readonly string[] }) =>
        input.statuses.includes("completed")
          ? { jobs, total: jobs.length }
          : { jobs: [] as readonly T[], total: 0 },
      );
    const emptyPage = completed([]);
    const skill: SkillLearningJob = {
      schemaVersion: "pragma.memory-skill-job/v1",
      id: "skill-job",
      revision: 5,
      rootRef: { type: "pragma.expert", id: "resource-1" },
      sourceDigest: "a".repeat(64),
      status: "completed",
      attempts: 3,
      completion: "rejected",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:03.000Z",
    };

    const board = await listDesktopMemoryExtractionJobs(
      {
        episodicStore: { listExtractionJobsPage: emptyPage },
        semanticStore: { listExtractionJobsPage: emptyPage },
        knowledgeLearningStore: { listJobsPage: emptyPage },
        skillLearningStore: { listJobsPage: completed([skill]) },
      } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[0],
      {
        ...emptyTitleOptions(),
        project: {
          get: vi.fn(async () => ({
            resources: [{ metadata: { id: "resource-1", name: "Research team" } }],
          })),
        },
      } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[1],
      FIRST_PAGES,
    );

    expect(board.lanes.completed.tasks).toEqual([
      expect.objectContaining({
        module: "skill",
        title: "Research team",
        completion: "rejected",
      }),
    ]);
    expect(board.lanes.completed.tasks[0]).not.toHaveProperty("lastErrorCode");
  });

  it("exposes a classified problem instead of a user-facing error code", async () => {
    const failed: KnowledgeExtractionJob = {
      ...knowledgeJob(1, "2026-08-05T00:00:01.000Z"),
      status: "needs_attention",
      attempts: 3,
      lastErrorCode: "extractor_evidence_ref_invalid",
      failureClass: "transient-exhausted",
    };
    const attention = vi.fn(async (input: { readonly statuses: readonly string[] }) =>
      input.statuses.includes("needs_attention")
        ? { jobs: [failed], total: 1 }
        : { jobs: [], total: 0 },
    );
    const emptyPage = vi.fn(async () => ({ jobs: [], total: 0 }));

    const board = await listDesktopMemoryExtractionJobs(
      {
        episodicStore: { listExtractionJobsPage: emptyPage },
        semanticStore: { listExtractionJobsPage: emptyPage },
        knowledgeLearningStore: { listJobsPage: attention },
      } as unknown as Parameters<typeof listDesktopMemoryExtractionJobs>[0],
      emptyTitleOptions(),
      FIRST_PAGES,
    );

    expect(board.lanes.attention.tasks[0]).toMatchObject({
      problem: {
        kind: "invalid_output",
        technicalCode: "extractor_evidence_ref_invalid",
      },
    });
    expect(board.lanes.attention.tasks[0]).not.toHaveProperty("lastErrorCode");
  });
});

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
    schemaVersion: "pragma.memory-extraction-job/v3",
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
    schemaVersion: "pragma.memory-semantic-job/v3",
  };
}

function knowledgeJob(index: number, updatedAt: string): KnowledgeExtractionJob {
  return {
    schemaVersion: "pragma.memory-knowledge-job/v2",
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
