import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentEvaluationRunSchema } from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createEvaluationService } from "./evaluation-service.ts";
import { createEvaluationStore } from "./evaluation-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Evaluation queue", () => {
  it("defaults to three case slots and persists setting updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-evaluation-"));
    roots.push(root);
    const store = createEvaluationStore(root);
    expect((await store.getSettings()).concurrency).toBe(3);
    await store.updateSettings((current) => ({
      ...current,
      revision: 1,
      concurrency: 5,
      updatedAt: new Date().toISOString(),
    }));
    expect((await createEvaluationStore(root).getSettings()).concurrency).toBe(5);
  });

  it("rejects one of two concurrent settings updates with the same revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-evaluation-"));
    roots.push(root);
    const service = createEvaluationService({
      store: createEvaluationStore(root),
      project: {} as PragmaProjectStore,
      executor: { execute: async () => Promise.reject(new Error("Unexpected execution.")) },
    });

    const results = await Promise.allSettled([
      service.updateSettings({ expectedRevision: 0, concurrency: 4 }),
      service.updateSettings({ expectedRevision: 0, concurrency: 5 }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({
        message: "Evaluation settings changed. Reload and try again.",
      }),
    });
    service.dispose();
  });

  it("never executes more cases than the global concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-evaluation-"));
    roots.push(root);
    const store = createEvaluationStore(root);
    await store.saveRun(runFixture());
    let active = 0;
    let maximum = 0;
    const releases: (() => void)[] = [];
    const service = createEvaluationService({
      store,
      project: {} as PragmaProjectStore,
      executor: {
        async execute({ evaluationCase, setPhase }) {
          active += 1;
          maximum = Math.max(maximum, active);
          await setPhase("judge");
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return {
            caseId: evaluationCase.id,
            output: "ok",
            toolTrace: [],
            assertions: [],
            judge: {
              schemaVersion: "pragma.evaluation-judge-result/v1",
              resolved: true,
              criteria: [{ id: "correct", passed: true, score: 100, evidence: "Correct." }],
              summary: "Resolved.",
            },
            resolved: true,
          };
        },
      },
    });
    await service.start();
    await waitUntil(() => releases.length === 3);
    expect(maximum).toBe(3);
    releases.splice(0).forEach((release) => release());
    await waitUntil(() => releases.length === 1);
    releases.splice(0).forEach((release) => release());
    await waitUntil(
      async () =>
        (await service.getRun("10000000-0000-4000-8000-000000000001")).status === "completed",
    );
    expect(
      (await service.getRun("10000000-0000-4000-8000-000000000001")).summary.resolvedRate,
    ).toBe(1);
    service.dispose();
  });

  it("aborts active cases and cancels every unfinished task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-evaluation-"));
    roots.push(root);
    const store = createEvaluationStore(root);
    await store.saveRun(runFixture());
    let started = 0;
    let aborted = 0;
    const service = createEvaluationService({
      store,
      project: {} as PragmaProjectStore,
      executor: {
        async execute({ evaluationCase, signal }) {
          started += 1;
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted += 1;
                resolve();
              },
              { once: true },
            );
          });
          return resolvedResult(evaluationCase.id);
        },
      },
    });

    await service.start();
    await waitUntil(() => started === 3);
    const cancelled = await service.cancelRun("10000000-0000-4000-8000-000000000001");
    await waitUntil(() => aborted === 3);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.tasks.every((task) => task.status === "cancelled")).toBe(true);
    await waitUntil(async () => {
      const persisted = await service.getRun("10000000-0000-4000-8000-000000000001");
      return persisted.tasks.every((task) => task.status === "cancelled");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.dispose();
  });
});

function resolvedResult(caseId: string) {
  return {
    caseId,
    output: "ok",
    toolTrace: [],
    assertions: [],
    judge: {
      schemaVersion: "pragma.evaluation-judge-result/v1" as const,
      resolved: true,
      criteria: [{ id: "correct", passed: true, score: 100, evidence: "Correct." }],
      summary: "Resolved.",
    },
    resolved: true,
  };
}

function runFixture() {
  const now = new Date().toISOString();
  const cases = ["a", "b", "c", "d"].map((id) => ({
    id,
    name: id,
    prompt: `Prompt ${id}`,
    criteria: [{ id: "correct", description: "Correct." }],
    assertions: { outputContains: [], outputNotContains: [], tools: [] },
    mocks: [],
  }));
  return AgentEvaluationRunSchema.parse({
    schemaVersion: "pragma.agent-evaluation-run/v1",
    id: "10000000-0000-4000-8000-000000000001",
    projectId: "studio",
    projectRevision: 1,
    evaluationRef: "evaluation:7h8j9k0m1n2p3q4r",
    evaluationName: "Fixture",
    group: "Tools",
    executionMode: "mock",
    targetRef: "expert:6h7j8k9m0n1p2q3r",
    targetName: "Expert",
    selectionSeed: "seed",
    selectedCaseIds: cases.map((item) => item.id),
    dataset: {
      apiVersion: "pragma/v4",
      kind: "Evaluation",
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Fixture",
        description: "Fixture dataset.",
        tags: [],
      },
      spec: { method: { type: "agent-judge", group: "Tools", execution: { mode: "mock" }, cases } },
    },
    judgeResultVersion: "pragma.evaluation-judge-result/v1",
    status: "queued",
    tasks: cases.map((item) => ({
      caseId: item.id,
      caseName: item.name,
      status: "queued",
      attempt: 1,
      createdAt: now,
    })),
    summary: {
      total: 4,
      completed: 0,
      resolved: 0,
      unresolved: 0,
      needsAttention: 0,
      cancelled: 0,
      resolvedRate: 0,
    },
    createdAt: now,
    updatedAt: now,
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for evaluation queue.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
