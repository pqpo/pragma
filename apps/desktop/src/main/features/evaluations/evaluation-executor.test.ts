import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EVALUATION_JUDGE_EXPERT_REF } from "@pragma/built-in-agents";
import { afterEach, describe, expect, it } from "vitest";

import { AgentEvaluationRunSchema, type Mission } from "../../../shared/contracts/index.ts";
import type { MissionRunner } from "../missions/mission-runner.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { EvaluationStore } from "./evaluation-store.ts";
import { createMissionAgentEvaluationExecutor } from "./evaluation-executor.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Mission agent evaluation executor", () => {
  it("uses the canonical Judge Agent ref", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-evaluation-executor-"));
    roots.push(root);
    const harness = missionHarness(true);
    const run = runFixture();
    const executor = createMissionAgentEvaluationExecutor({
      missions: harness.missions,
      runner: harness.runner,
      project: projectFixture(),
      store: settingsStore(),
      mocks: {
        begin() {},
        finish: () => [],
        forMission: (_mission, fallback) => fallback,
      },
      workspaceRoot: root,
    });

    const result = await executor.execute({
      run,
      evaluationCase: run.dataset.spec.method.cases[0]!,
      setPhase: async () => undefined,
      signal: new AbortController().signal,
    });

    expect(harness.created).toHaveLength(2);
    expect(harness.created[1]?.executor.ref).toBe(EVALUATION_JUDGE_EXPERT_REF);
    expect(result.resolved).toBe(true);
  });

  it("interrupts an active Mission when its evaluation task is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-evaluation-executor-"));
    roots.push(root);
    const harness = missionHarness(false);
    const run = runFixture();
    const controller = new AbortController();
    const executor = createMissionAgentEvaluationExecutor({
      missions: harness.missions,
      runner: harness.runner,
      project: projectFixture(),
      store: settingsStore(),
      mocks: {
        begin() {},
        finish: () => [],
        forMission: (_mission, fallback) => fallback,
      },
      workspaceRoot: root,
    });

    const execution = executor.execute({
      run,
      evaluationCase: run.dataset.spec.method.cases[0]!,
      setPhase: async () => undefined,
      signal: controller.signal,
    });
    await waitUntil(() => harness.created.length === 1);
    controller.abort();

    await expect(execution).rejects.toThrow("cancelled");
    expect(harness.interrupted).toBe(1);
  });
});

function missionHarness(completeImmediately: boolean): {
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly created: Parameters<MissionStore["create"]>[0][];
  readonly interrupted: number;
} {
  const created: Parameters<MissionStore["create"]>[0][] = [];
  const records = new Map<string, Mission>();
  let interrupted = 0;
  const missions = {
    async create(input: Parameters<MissionStore["create"]>[0]) {
      created.push(input);
      const id = `10000000-0000-4000-8000-00000000000${created.length}`;
      const now = new Date().toISOString();
      const mission = {
        ...input,
        schemaVersion: "pragma.mission/v8",
        id,
        title: input.title ?? input.goal,
        initialMessageId: `20000000-0000-4000-8000-00000000000${created.length}`,
        lifecycleStatus: "active",
        createdAt: now,
        updatedAt: now,
        contextStoreIds: input.contextStoreIds ?? [],
      } as Mission;
      records.set(id, mission);
      return mission;
    },
    async get(id: string) {
      return records.get(id)!;
    },
  } as unknown as MissionStore;
  const runner = {
    async run(id: string) {
      const mission = records.get(id)!;
      if (!completeImmediately) return mission;
      const now = new Date().toISOString();
      const finished = {
        ...mission,
        execution: {
          id: `30000000-0000-4000-8000-00000000000${created.length}`,
          inputMessageId: mission.initialMessageId,
          status: "succeeded",
          startedAt: now,
          finishedAt: now,
        },
      } as Mission;
      records.set(id, finished);
      return finished;
    },
    async getChat(input: Parameters<MissionRunner["getChat"]>[0]) {
      const mission = records.get(input.id)!;
      const output =
        mission.origin.type === "system-evaluation" && mission.origin.phase === "judge"
          ? JSON.stringify({
              schemaVersion: "pragma.evaluation-judge-result/v1",
              resolved: true,
              criteria: [{ id: "correct", passed: true, score: 100, evidence: "Correct." }],
              summary: "Resolved.",
            })
          : "Customer is active.";
      return {
        missionId: mission.id,
        revision: 0,
        entries: [
          {
            id: `assistant-${created.length}`,
            kind: "assistant" as const,
            content: output,
            streaming: false,
            createdAt: new Date().toISOString(),
          },
        ],
        page: {},
        pendingInteractions: [],
      };
    },
    async interrupt(id: string) {
      interrupted += 1;
      const mission = records.get(id)!;
      const now = new Date().toISOString();
      const cancelled = {
        ...mission,
        execution: {
          id: "30000000-0000-4000-8000-000000000099",
          inputMessageId: mission.initialMessageId,
          status: "cancelled",
          startedAt: now,
          finishedAt: now,
        },
      } as Mission;
      records.set(id, cancelled);
      return cancelled;
    },
    async delete(id: string) {
      records.delete(id);
    },
  } as unknown as MissionRunner;
  return {
    missions,
    runner,
    created,
    get interrupted() {
      return interrupted;
    },
  };
}

function projectFixture(): PragmaProjectStore {
  return {
    projectId: "studio",
    async openRevision() {
      return {
        listResources: () => [
          {
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "Expert",
            metadata: {
              id: "6h7j8k9m0n1p2q3r",
              name: "Expert",
              description: "Expert under test.",
              tags: [],
            },
          },
        ],
        async dispose() {},
      };
    },
  } as unknown as PragmaProjectStore;
}

function settingsStore(): EvaluationStore {
  return {
    async getSettings() {
      return {
        schemaVersion: "pragma.evaluation-settings/v1",
        revision: 0,
        concurrency: 3,
        judge: { mode: "inherit-default" },
        updatedAt: new Date(0).toISOString(),
      };
    },
  } as unknown as EvaluationStore;
}

function runFixture() {
  const now = new Date().toISOString();
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
    selectedCaseIds: ["lookup"],
    dataset: {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Evaluation",
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Fixture",
        description: "Fixture dataset.",
        tags: [],
      },
      spec: {
        method: {
          type: "agent-judge",
          group: "Tools",
          execution: { mode: "mock" },
          cases: [
            {
              id: "lookup",
              name: "Lookup",
              prompt: "Find the customer.",
              criteria: [{ id: "correct", description: "Correct." }],
              assertions: { outputContains: ["active"], outputNotContains: [], tools: [] },
              mocks: [],
            },
          ],
        },
      },
    },
    judgeResultVersion: "pragma.evaluation-judge-result/v1",
    status: "queued",
    tasks: [{ caseId: "lookup", caseName: "Lookup", status: "queued", attempt: 1, createdAt: now }],
    summary: {
      total: 1,
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Mission creation.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
