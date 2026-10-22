import type { SkillSourceSnapshot } from "@pragma/shared";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { LocalHostMissionApplication } from "@pragma/local-host";
import type { MissionStore } from "@pragma/local-host";
import { MissionStoreError } from "@pragma/local-host";
import type { PragmaProjectStore } from "@pragma/local-host/deployment";
import { createMemoryRevisionLearningPlanners } from "./memory-revision-learning-planners.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("cleans only registered orphan planning Missions and replays a missing-Mission marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-plan-"));
  roots.push(root);
  const registry = join(root, "state", "memory-revision-planning");
  await mkdir(registry, { recursive: true });
  const existing = randomUUID();
  const alreadyDeleted = randomUUID();
  await Promise.all([
    writeFile(join(registry, existing), ""),
    writeFile(join(registry, alreadyDeleted), ""),
    writeFile(join(registry, "unrelated-file"), ""),
  ]);
  const deleteMission = vi.fn(async (id: string) => {
    if (id === alreadyDeleted) throw new MissionStoreError("mission_not_found", "Already deleted");
  });
  const planners = createMemoryRevisionLearningPlanners({
    pragmaHome: root,
    missions: {} as MissionStore,
    application: { delete: deleteMission } as unknown as LocalHostMissionApplication,
    project: {} as PragmaProjectStore,
  });
  expect(await planners.recoverOrphans()).toBe(2);
  expect(deleteMission).toHaveBeenCalledTimes(2);
  expect(await readdir(registry)).toEqual(["unrelated-file"]);
});

it("uses the Store Revision Agent for a read-only plan and removes its Mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-plan-"));
  roots.push(root);
  const missionId = randomUUID();
  const create = vi.fn(async () => ({ id: missionId }));
  const remove = vi.fn(async () => undefined);
  const readInternal = vi.fn(async () => ({
    entries: [{ kind: "assistant", executionId: "execution-0", content: '{"action":"skip"}' }],
  }));
  const readUserChat = vi.fn(async () => {
    throw new Error("Internal Missions are not available on the Mission surface.");
  });
  const planners = createMemoryRevisionLearningPlanners({
    pragmaHome: root,
    missions: {
      create,
      get: async () => ({ execution: { id: "execution-0", status: "succeeded" } }),
    } as unknown as MissionStore,
    application: {
      startRun: async () => undefined,
      getChatPage: readUserChat,
      getInternalConversationSnapshot: readInternal,
      delete: remove,
    } as unknown as LocalHostMissionApplication,
    project: {
      ensurePublished: async () => ({ projectId: "project", revision: 1 }),
    } as unknown as PragmaProjectStore,
  });
  expect(
    await planners.knowledge.plan({
      rootRef: { type: "pragma.expert", id: "expert-a" },
      expertRef: "expert:expert-a",
      sourceDigest: "a".repeat(64),
      sources: [],
      signal: new AbortController().signal,
    }),
  ).toEqual({ action: "skip" });
  expect(readInternal).toHaveBeenCalledWith(missionId);
  expect(readUserChat).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      executor: expect.objectContaining({ ref: "expert:0000000000st0rev" }),
      origin: { type: "system-memory", jobId: `knowledge-plan:${"a".repeat(64)}` },
    }),
  );
  expect(remove).toHaveBeenCalledWith(missionId);
  expect(await readdir(join(root, "state", "memory-revision-planning"))).toEqual([]);
});

it("preserves Runtime failure codes so configuration jobs can be woken", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-plan-"));
  roots.push(root);
  const planners = createMemoryRevisionLearningPlanners({
    pragmaHome: root,
    missions: {
      create: async () => ({ id: randomUUID() }),
      get: async () => ({ execution: { status: "failed", error: "Runtime failed" } }),
    } as unknown as MissionStore,
    application: {
      startRun: async () => undefined,
      getTerminalRuntimeFailure: async () => ({
        code: "runtime_unavailable",
        message: "No Runtime is configured.",
        retryable: false,
        failedAt: new Date().toISOString(),
      }),
      delete: async () => undefined,
    } as unknown as LocalHostMissionApplication,
    project: {
      ensurePublished: async () => ({ projectId: "project", revision: 1 }),
    } as unknown as PragmaProjectStore,
  });
  await expect(
    planners.knowledge.plan({
      rootRef: { type: "pragma.expert", id: "expert-a" },
      expertRef: "expert:expert-a",
      sourceDigest: "b".repeat(64),
      sources: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "runtime_unavailable", retryable: false });
});

async function planningFixture(
  responses: readonly string[],
  signal = new AbortController().signal,
  status = "succeeded",
) {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-plan-repair-"));
  roots.push(root);
  const missionId = randomUUID();
  let turn = 0;
  const create = vi.fn(async () => ({ id: missionId }));
  const remove = vi.fn(async () => undefined);
  const continuation = vi.fn(
    async (_input: {
      id: string;
      previousExecutionId: string;
      requestId: string;
      content: string;
    }) => {
      expect(_input.id).toBe(missionId);
      return { executionId: `execution-${++turn}` };
    },
  );
  const read = vi.fn(
    async (): Promise<{
      entries: { kind: string; content: string | undefined; executionId?: string }[];
    }> => ({
      entries: [
        {
          kind: "assistant",
          executionId: `execution-${turn}`,
          content: responses[Math.min(turn, responses.length - 1)],
        },
      ],
    }),
  );
  const get = vi.fn(async () => ({ execution: { id: `execution-${turn}`, status } }));
  const readFailure = vi.fn(async () => undefined);
  const planners = createMemoryRevisionLearningPlanners({
    pragmaHome: root,
    missions: {
      create,
      get,
    } as unknown as MissionStore,
    application: {
      startRun: vi.fn(async () => undefined),
      continueInternalMemoryMission: continuation,
      getInternalConversationSnapshot: read,
      getTerminalRuntimeFailure: readFailure,
      interrupt: vi.fn(async () => undefined),
      delete: remove,
    } as unknown as LocalHostMissionApplication,
    project: {
      ensurePublished: async () => ({ projectId: "project", revision: 1 }),
    } as unknown as PragmaProjectStore,
  });
  const input = {
    rootRef: { type: "pragma.expert", id: "expert-a" } as const,
    expertRef: "expert:expert-a",
    sourceDigest: "c".repeat(64),
    sources: [],
    existingTargets: [],
    signal,
  };
  return { planners, input, create, remove, continuation, missionId, read, get, readFailure };
}

it("repairs oversized descriptions and missing citations in the same Skill planning Mission", async () => {
  const refs = [1, 2, 3].map((revision) => ({
    kind: "episodic",
    id: `episode-${revision}`,
    revision,
  }));
  const change = {
    name: "Workflow",
    description: "Reusable workflow",
    normalizedKey: "workflow.test",
    sourceRefs: refs,
    target: { type: "create" },
  };
  const valid = { action: "apply", changes: [change] };
  const f = await planningFixture([
    JSON.stringify({
      action: "apply",
      changes: [{ ...change, description: "x".repeat(501), sourceRefs: refs.slice(0, 2) }],
    }),
    JSON.stringify(valid),
  ]);
  await expect(f.planners.skill.plan({ ...f.input, sources: planningSources() })).resolves.toEqual(
    valid,
  );
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.continuation).toHaveBeenCalledOnce();
  expect(f.continuation).toHaveBeenCalledWith(
    expect.objectContaining({
      id: f.missionId,
      previousExecutionId: "execution-0",
      content: expect.stringContaining('"path":["changes",0,"description"]'),
    }),
  );
  expect(f.continuation.mock.calls[0]![0]).toEqual(
    expect.objectContaining({
      content: expect.stringContaining('"path":["changes",0,"sourceRefs"]'),
    }),
  );
  expect(f.remove).toHaveBeenCalledWith(f.missionId);
}, 15_000);

it("bounds invalid JSON repairs without authorizing a fresh planning Mission", async () => {
  const f = await planningFixture(['{"action":']);
  await expect(f.planners.knowledge.plan(f.input)).rejects.toMatchObject({ retryable: false });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.continuation).toHaveBeenCalledTimes(2);
  expect(f.continuation.mock.calls[1]![0]).toEqual(
    expect.objectContaining({ previousExecutionId: "execution-1" }),
  );
}, 20_000);

it("does not admit an already cancelled planning run", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const f = await planningFixture(['{"action":"skip"}'], controller.signal);
  await expect(f.planners.skill.plan(f.input)).rejects.toThrow("cancelled");
  expect(f.create).not.toHaveBeenCalled();
  expect(f.continuation).not.toHaveBeenCalled();
});

it("does not replay a cancelled terminal planning turn", async () => {
  const f = await planningFixture(['{"action":"skip"}'], undefined, "cancelled");
  await expect(f.planners.skill.plan(f.input)).rejects.toMatchObject({
    message: "memory_revision_planning_cancelled",
    retryable: false,
  });
  expect(f.continuation).not.toHaveBeenCalled();
});

it("stops correction when cancelled after reading an invalid plan", async () => {
  const controller = new AbortController();
  const f = await planningFixture(["invalid"], controller.signal);
  f.read.mockImplementationOnce(async () => {
    controller.abort(new Error("cancelled during correction"));
    return { entries: [{ kind: "assistant", content: "invalid" }] };
  });
  await expect(f.planners.skill.plan(f.input)).rejects.toThrow("cancelled during correction");
  expect(f.continuation).not.toHaveBeenCalled();
});

it("does not replace an unconfirmed correction dispatch with a fresh planning Mission", async () => {
  const f = await planningFixture(["invalid"]);
  f.continuation.mockRejectedValueOnce(new Error("connection_lost"));
  await expect(f.planners.skill.plan(f.input)).rejects.toMatchObject({
    message: "connection_lost",
    retryable: false,
  });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.continuation).toHaveBeenCalledOnce();
}, 15_000);

it("rereads a successful planning result without admitting another model", async () => {
  const f = await planningFixture(['{"action":"skip"}']);
  f.read.mockRejectedValueOnce(new Error("transcript temporarily unavailable"));
  await expect(f.planners.knowledge.plan(f.input)).resolves.toEqual({ action: "skip" });
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.continuation).not.toHaveBeenCalled();
  expect(f.create).toHaveBeenCalledOnce();
}, 15_000);

it("parks unreadable successful output without authorizing a fresh model attempt", async () => {
  const f = await planningFixture(['{"action":"skip"}']);
  f.read.mockRejectedValue(new Error("transcript unavailable"));
  await expect(f.planners.knowledge.plan(f.input)).rejects.toMatchObject({
    code: "memory_revision_plan_read_failed",
    retryable: false,
  });
  expect(f.read).toHaveBeenCalledTimes(4);
  expect(f.continuation).not.toHaveBeenCalled();
}, 25_000);

it("ignores earlier execution output when reading the current planning result", async () => {
  const plan = { action: "apply", name: "Current knowledge", description: "Guidance" };
  const f = await planningFixture([JSON.stringify(plan)]);
  f.read.mockResolvedValueOnce({
    entries: [
      { kind: "assistant", executionId: "earlier-execution", content: '{"action":"skip"}' },
    ],
  });
  await expect(f.planners.knowledge.plan(f.input)).resolves.toEqual(plan);
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.continuation).not.toHaveBeenCalled();
}, 15_000);

it("does not replay a Mission when its terminal observation is unavailable", async () => {
  const f = await planningFixture(['{"action":"skip"}']);
  f.get.mockRejectedValueOnce(new Error("mission read unavailable"));
  await expect(f.planners.knowledge.plan(f.input)).rejects.toMatchObject({
    code: "memory_revision_planning_observation_failed",
    retryable: false,
  });
  expect(f.read).not.toHaveBeenCalled();
  expect(f.continuation).not.toHaveBeenCalled();
});

it("does not replay a failed Mission when Runtime diagnostics cannot be read", async () => {
  const f = await planningFixture(['{"action":"skip"}'], undefined, "failed");
  f.readFailure.mockRejectedValueOnce(new Error("diagnostics unavailable"));
  await expect(f.planners.knowledge.plan(f.input)).rejects.toMatchObject({
    code: "memory_revision_planning_observation_failed",
    retryable: false,
  });
  expect(f.continuation).not.toHaveBeenCalled();
});

it("honors cancellation arriving with an otherwise valid planning result", async () => {
  const controller = new AbortController();
  const f = await planningFixture(['{"action":"skip"}'], controller.signal);
  f.read.mockImplementationOnce(async () => {
    controller.abort(new Error("cancelled after result read"));
    return {
      entries: [{ kind: "assistant", executionId: "execution-0", content: '{"action":"skip"}' }],
    };
  });
  await expect(f.planners.skill.plan(f.input)).rejects.toThrow("cancelled after result read");
  expect(f.continuation).not.toHaveBeenCalled();
});

function planningSources(): SkillSourceSnapshot[] {
  return [1, 2, 3].map((revision) => ({
    ref: { kind: "episodic", id: `episode-${revision}`, revision },
    rootRef: { type: "pragma.expert", id: "expert-a" },
    conversationRef: { type: "pragma.mission", id: `mission-${revision}` },
    sourceExecutionIds: [],
    producerRefs: [],
    title: "Workflow",
    body: "Reusable workflow",
    outcome: "succeeded",
    hasSuccessfulRecovery: false,
    valueScore: 0.85,
    observedAt: "2026-10-22T00:00:00.000Z",
    verified: true,
    visibility: { mode: "host-private" },
    sensitivity: "internal",
  }));
}

it("repairs business threshold errors in the same planning conversation", async () => {
  const sources = planningSources();
  const change = {
    name: "Workflow",
    description: "Reusable workflow",
    normalizedKey: "workflow.test",
    sourceRefs: sources.map((source) => source.ref),
    target: { type: "create" },
  };
  const low = {
    ...sources[2]!,
    ref: { kind: "episodic" as const, id: "low", revision: 1 },
    valueScore: 0.8,
  };
  const f = await planningFixture([
    JSON.stringify({
      action: "apply",
      changes: [{ ...change, sourceRefs: [sources[0]!.ref, sources[1]!.ref, low.ref] }],
    }),
    JSON.stringify({ action: "apply", changes: [change] }),
  ]);
  await expect(f.planners.skill.plan({ ...f.input, sources: [...sources, low] })).resolves.toEqual({
    action: "apply",
    changes: [change],
  });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.continuation).toHaveBeenCalledOnce();
  expect(f.continuation.mock.calls[0]![0].content).toContain("valueScore >= 0.85");
}, 15_000);

it("keeps valid changes after exhausting same-conversation business corrections", async () => {
  const sources = planningSources();
  const change = {
    name: "Workflow",
    description: "Reusable workflow",
    normalizedKey: "workflow.test",
    sourceRefs: sources.map((source) => source.ref),
    target: { type: "create" },
  };
  const invalid = {
    ...change,
    normalizedKey: "workflow.invalid",
    sourceRefs: [sources[0]!.ref, sources[1]!.ref, sources[0]!.ref],
  };
  const f = await planningFixture([
    JSON.stringify({ action: "apply", changes: [invalid, change] }),
  ]);
  await expect(f.planners.skill.plan({ ...f.input, sources })).resolves.toEqual({
    action: "apply",
    changes: [change],
  });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.continuation).toHaveBeenCalledTimes(2);
}, 20_000);

it("returns skip when no proposed Skill survives business corrections", async () => {
  const change = {
    name: "Workflow",
    description: "Reusable workflow",
    normalizedKey: "workflow.test",
    sourceRefs: planningSources().map((source) => source.ref),
    target: { type: "create" },
  };
  const f = await planningFixture([JSON.stringify({ action: "apply", changes: [change] })]);
  const onRejectedChanges = vi.fn();
  await expect(f.planners.skill.plan({ ...f.input, onRejectedChanges })).resolves.toEqual({
    action: "skip",
  });
  expect(onRejectedChanges).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        index: 0,
        message: expect.stringContaining("exact supplied sourceRefs"),
      }),
    ]),
  );
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.continuation).toHaveBeenCalledTimes(2);
}, 20_000);
