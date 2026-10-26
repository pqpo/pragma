import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createStaticRuntimeResolver,
  getToolResultText,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  type ExpertAgentManagedTool,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import {
  builtInAgentResource,
  compileBuiltInAgent,
  STORE_REVISION_EXPERT_REF,
  SKILL_REVISION_EXPERT_REF,
  type KnowledgeRevisionSubmissionPort,
  type SkillRevisionSubmissionPort,
} from "@pragma/built-in-agents";
import {
  createMissionStore,
  withMissionPreparationFailure,
  type LocalHostMissionApplication,
} from "@pragma/local-host";
import type { PragmaProjectStore } from "@pragma/local-host/deployment";
import { KnowledgeSourceSnapshotSchema } from "@pragma/shared";
import { createMemoryRevisionExecutor } from "./memory-revision-executor.ts";
import type { createMemoryLearningRevisions } from "./memory-learning-revisions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = {
  toolCallId: "call-1",
  runContext: {
    attributes: {
      [EXECUTION_ID_ATTR]: "execution-1",
      [INVOCATION_ID_ATTR]: "invocation-1",
      [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "0000000000st0rev",
    },
  },
};
type Tool = ExpertAgentManagedTool<string, unknown>;
async function fixture(kind: "knowledge" | "skill" = "knowledge") {
  const root = await mkdtemp(join(tmpdir(), "pragma-direct-revision-"));
  roots.push(root);
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const source = KnowledgeSourceSnapshotSchema.parse({
    ref: { kind: "episodic", id: "episode-1", revision: 1 },
    rootRef: { type: "pragma.expert", id: "0000000000000002" },
    producerRefs: [{ type: "pragma.expert", id: "0000000000000002" }],
    sourceExecutionIds: ["execution-1"],
    title: "Verified workflow",
    body: "Run verify.py; it actually passed.",
    observedAt: "2026-10-26T00:00:00.000Z",
    outcome: "succeeded",
    verified: true,
    sensitivity: "internal",
    visibility: { mode: "host-private" },
  });
  const revisions = {
    listKnowledgeTargets: vi.fn<
      ReturnType<typeof createMemoryLearningRevisions>["listKnowledgeTargets"]
    >(async () => []),
    listSkillTargets: vi.fn<ReturnType<typeof createMemoryLearningRevisions>["listSkillTargets"]>(
      async () => [],
    ),
    trackDirectDraft: vi.fn(async () => undefined),
    recoverDirectDrafts: vi.fn(async () => []),
    getDirectDraftVersion: vi.fn(async () => ({ id: targetId, revision: 1, hash: "b".repeat(64) })),
    getDirectKnowledgeDraft: vi.fn(async () => false),
    getDirectSkillDraft: vi.fn(async () => false),
    readKnowledgeTarget: vi.fn(async () => "# Existing guidance"),
  };
  const runtimes = createStaticRuntimeResolver({
    defaultRuntimeId: "fake",
    runtimes: [
      defineRuntimeTestDriver<never, { id: string }>({
        descriptor: { id: "fake", kind: "test", displayName: "Fixture" },
        createSession: () => ({ id: "native" }),
        readSession: () => ({ runtimeSessionId: "native" }),
        startTurn: () => ({ outputText: "unused", runtimeSessionId: "native" }),
        mapEvent: () => ({ events: [] }),
      }),
    ],
  });
  let turn: (tools: Tool[], missionId: string) => Promise<void> = async (tools) => {
    await call(tools, "finish_memory_learning", {
      disposition: "accumulate",
      reason: "No new supported delta.",
    });
  };
  let terminalStatus: "succeeded" | "failed" = "succeeded";
  let tools: Tool[] = [];
  const targetId = randomUUID(),
    draftId = randomUUID(),
    jobId = randomUUID();
  const port = {
    start: vi.fn(async () => ({
      jobId,
      draftId,
      state: "editing",
      creation: { resourceId: targetId, name: "Verified workflow", description: "Guidance" },
      writableNamespace: "draft",
    })),
    submitDraft: vi.fn(async () => ({
      draftId,
      revision: 2,
      state: "pending_review",
      baseRevision: 0,
      stale: false,
      changedPaths: ["items/guide.md"],
      submittedRevision: 2,
    })),
  } as unknown as KnowledgeRevisionSubmissionPort;
  const skillPort = {
    start: vi.fn(async () => ({
      jobId,
      draftId,
      state: "editing",
      creation: { resourceId: targetId, name: "Verified workflow", description: "Guidance" },
      draftPath: join(root, "draft"),
    })),
    submitDraft: vi.fn(async () => ({ draftId, jobId, revision: 2, state: "pending_review" })),
  } as unknown as SkillRevisionSubmissionPort;
  const compile = async (missionId: string) => {
    const mission = await missions.get(missionId);
    const ref = kind === "knowledge" ? STORE_REVISION_EXPERT_REF : SKILL_REVISION_EXPERT_REF;
    const adapted = await api.source(
      mission,
      builtInAgentResource(ref),
      {
        environmentId: "test",
        projectRoot: root,
        resolveBinding: async () => undefined,
        resolveSecret: async () => undefined,
        resolveArtifact: async () => {
          throw new Error("Unexpected artifact");
        },
      },
      kind === "knowledge" ? { knowledgeRevisions: port } : { skillRevisions: skillPort },
    );
    const compiled = await compileBuiltInAgent({
      ...adapted,
      ref,
      environmentId: "test",
      definitionStateRoot: join(root, "definitions"),
      workspace: root,
      pragmaHome: root,
      runtimes,
      rootExecutionOverride: { runtimeId: "fake" },
    });
    tools = [...(compiled.value.tools ?? [])];
    expect(tools.map((tool) => tool.name)).toContain("read_learning_source");
    expect(tools.map((tool) => tool.name)).not.toContain("askUserQuestion");
    return tools;
  };
  const application = {
    startRun: vi.fn(async (missionId: string) => {
      await turn(await compile(missionId), missionId);
      const mission = await missions.get(missionId);
      await missions.updateExecution(missionId, {
        id: randomUUID(),
        sessionId: randomUUID(),
        inputMessageId: mission.initialMessageId,
        status: terminalStatus,
        startedAt: new Date().toISOString(),
      });
    }),
    continueInternalMemoryMission: vi.fn(async (input: { id: string }) => {
      await application.startRun(input.id);
      return { executionId: (await missions.get(input.id)).execution!.id };
    }),
    getTerminalRuntimeFailure: vi.fn<LocalHostMissionApplication["getTerminalRuntimeFailure"]>(
      async () => undefined,
    ),
    delete: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
  };
  const options = {
    pragmaHome: root,
    missions,
    application: application as unknown as LocalHostMissionApplication,
    project: {
      ensurePublished: async () => ({ projectId: "0000000000000001", revision: 1 }),
    } as unknown as PragmaProjectStore,
    revisions: revisions as unknown as ReturnType<typeof createMemoryLearningRevisions>,
  };
  let api = createMemoryRevisionExecutor(options);
  const input = {
    kind,
    jobId: randomUUID(),
    claimRevision: 2,
    manualRetry: true,
    rootRef: source.rootRef,
    expertRef: "expert:0000000000000002",
    sourceDigest: "a".repeat(64),
    sources: [source],
    signal: new AbortController().signal,
    assertCurrent: vi.fn(async () => undefined),
  };
  return {
    root,
    api: () => api,
    reopen: () => {
      api = createMemoryRevisionExecutor(options);
    },
    input,
    missions,
    application,
    revisions,
    port,
    skillPort,
    targetId,
    draftId,
    setStatus: (status: typeof terminalStatus) => {
      terminalStatus = status;
    },
    setTurn: (next: typeof turn) => {
      turn = next;
    },
    tools: () => tools,
    compile,
  };
}
async function call(tools: Tool[], name: string, args: unknown) {
  const result = await tools.find((tool) => tool.name === name)!.call(args, undefined, context);
  return JSON.parse(getToolResultText(result as Parameters<typeof getToolResultText>[0]));
}

it("compiles the real binding and saves a durable no-change receipt without a Planner", async () => {
  const f = await fixture();
  const result = await f.api().executor.execute(f.input);
  expect(result).toMatchObject({ submitted: false, decision: { outcome: "accumulate" } });
  expect(f.application.startRun).toHaveBeenCalledOnce();
  const mission = await f.missions.get(f.application.startRun.mock.calls[0]![0]);
  expect(mission.origin).toMatchObject({
    type: "system-memory",
    jobId: expect.stringMatching(/^knowledge-revision:/u),
  });
  f.reopen();
  expect(await f.api().executor.execute(f.input)).toEqual(result);
  expect(f.application.startRun).toHaveBeenCalledOnce();
});

it("rejects unauthorized citations and permits same-execution correction", async () => {
  const f = await fixture();
  f.setTurn(async (tools) => {
    expect(
      await call(tools, "read_learning_source", { handle: "private:other", offset: 0 }),
    ).toMatchObject({ error: "memory_revision_source_denied" });
    expect(await call(tools, "select_learning_sources", { handles: ["made-up"] })).toMatchObject({
      error: "memory_revision_source_denied",
    });
    const page = await call(tools, "list_learning_sources", {});
    expect(
      await call(tools, "read_learning_source", { handle: page.items[0].handle }),
    ).toMatchObject({ text: expect.stringContaining("actually passed") });
    expect(
      await call(tools, "select_learning_sources", { handles: [page.items[0].handle] }),
    ).toMatchObject({ selected: [page.items[0].handle] });
    await call(tools, "finish_memory_learning", {
      disposition: "duplicate",
      reason: "Already represented.",
    });
  });
  expect(await f.api().executor.execute(f.input)).toMatchObject({
    decision: { outcome: "duplicate" },
  });
  expect(f.application.startRun).toHaveBeenCalledOnce();
});

it("never replaces an unknown dispatch with another model call after restart", async () => {
  const f = await fixture();
  f.application.startRun.mockRejectedValueOnce(new Error("lost dispatch acknowledgement"));
  await expect(f.api().executor.execute(f.input)).rejects.toThrow("lost dispatch");
  f.reopen();
  await expect(f.api().executor.execute({ ...f.input, claimRevision: 4 })).rejects.toThrow(
    "memory_revision_admission_unconfirmed",
  );
  expect(f.application.startRun).toHaveBeenCalledOnce();
  expect(f.application.delete).not.toHaveBeenCalled();
});

it("preserves budget consumption across compilation and restart and rejects future state", async () => {
  const f = await fixture();
  await f.api().executor.execute(f.input);
  const root = join(f.root, "state", "memory-direct-revisions-v1");
  const file = (await readdir(root)).find((name) => name.endsWith(".json"))!;
  const state = JSON.parse(await readFile(join(root, file), "utf8"));
  expect(state.inspections).toBe(0); // finish uses its reserved control allocation
  state.result = undefined;
  state.disposition = undefined;
  state.inspections = 128;
  await writeFile(join(root, file), JSON.stringify(state));
  f.reopen();
  f.setTurn(async () => undefined);
  await expect(f.api().executor.execute(f.input)).rejects.toThrow(
    "memory_revision_receipt_missing",
  );
  const tools = await f.compile(f.application.startRun.mock.calls[0]![0]);
  await expect(call(tools, "list_learning_sources", {})).rejects.toThrow(
    "memory_revision_read_budget_exhausted",
  );
  state.schemaVersion = "pragma.memory-direct-revision/v2";
  await writeFile(join(root, file), JSON.stringify(state));
  f.reopen();
  await expect(f.api().executor.execute(f.input)).rejects.toThrow();
  expect(f.application.startRun).toHaveBeenCalledOnce();
});

it("reuses an inspected existing target and retains durable submission across manual retry", async () => {
  const f = await fixture();
  f.revisions.listKnowledgeTargets.mockResolvedValue([
    {
      storeId: f.targetId,
      name: "Existing guidance",
      description: "Verified workflow",
      baseRevision: 1,
      snapshotHash: "b".repeat(64),
      mounted: true,
      pending: false,
    },
  ]);
  f.setTurn(async (tools) => {
    const sources = await call(tools, "list_learning_sources", {});
    await call(tools, "read_learning_source", { handle: sources.items[0].handle });
    await call(tools, "select_learning_sources", { handles: [sources.items[0].handle] });
    const catalog = await call(tools, "find_learning_targets", {});
    const target = catalog.items[0];
    vi.mocked(f.port.start).mockResolvedValueOnce({
      jobId: randomUUID(),
      draftId: f.draftId,
      state: "editing",
      target: {
        targetRef: target.targetRef,
        name: target.name,
        description: target.description,
        revision: 1,
        mounted: true,
        mounts: [],
      },
      writableNamespace: "draft",
    });
    expect(
      await call(tools, "knowledge_revision_start", {
        targetRef: target.targetRef,
        prompt: "Add the verified check",
      }),
    ).toMatchObject({ code: expect.any(String) });
    await call(tools, "read_learning_target", { targetId: target.id });
    const started = await call(tools, "knowledge_revision_start", {
      targetRef: target.targetRef,
      prompt: "Add the verified check",
    });
    expect(started.draftId).toBe(f.draftId);
    f.revisions.listKnowledgeTargets.mockResolvedValue([
      {
        storeId: f.targetId,
        name: "Existing guidance",
        description: "Verified workflow",
        baseRevision: 1,
        snapshotHash: "b".repeat(64),
        mounted: true,
        pending: true,
      },
    ]);
    expect(await call(tools, "read_learning_target", { targetId: f.targetId })).toMatchObject({
      text: "# Existing guidance",
    });
    vi.mocked(f.port.start).mockResolvedValueOnce({
      jobId: randomUUID(),
      draftId: f.draftId,
      state: "editing",
      target: {
        targetRef: target.targetRef,
        name: target.name,
        description: target.description,
        revision: 1,
        mounted: true,
        mounts: [],
      },
      writableNamespace: "draft",
    });
    expect(
      await call(tools, "knowledge_revision_start", {
        draftId: f.draftId,
        prompt: "Continue the existing draft",
      }),
    ).toMatchObject({ draftId: f.draftId });
    const receipt = await call(tools, "knowledge_revision_submit_draft", {
      draftId: f.draftId,
      expectedRevision: 1,
      summary: "Add verified check",
    });
    expect(receipt.state).toBe("pending_review");
    expect(
      await call(tools, "knowledge_revision_submit_draft", {
        draftId: f.draftId,
        expectedRevision: 1,
        summary: "Add verified check",
      }),
    ).toEqual(receipt);
  });
  f.setStatus("failed");
  await expect(f.api().executor.execute(f.input)).rejects.toThrow(
    "memory_revision_execution_failed",
  );
  expect(f.port.start).toHaveBeenCalledTimes(2);
  expect(f.port.submitDraft).toHaveBeenCalledOnce();
  expect(f.application.delete).not.toHaveBeenCalled();
  f.reopen();
  f.setStatus("succeeded");
  f.setTurn(async (tools) => {
    await call(tools, "finish_memory_learning", {
      disposition: "duplicate",
      reason: "The supported draft was already submitted.",
    });
  });
  expect(await f.api().executor.execute({ ...f.input, claimRevision: 5 })).toMatchObject({
    submitted: true,
    decision: { outcome: "revise" },
  });
  expect(f.application.continueInternalMemoryMission).toHaveBeenCalledOnce();
  expect(f.port.start).toHaveBeenCalledTimes(2);
  expect(f.port.submitDraft).toHaveBeenCalledOnce();
});

it("retries a proven unstarted preparation failure in the original Mission", async () => {
  const f = await fixture();
  f.application.startRun.mockImplementationOnce(async (id) =>
    withMissionPreparationFailure(await f.missions.get(id), async () => {
      throw new Error("compile unavailable");
    }),
  );
  await expect(f.api().executor.execute(f.input)).rejects.toThrow("compile unavailable");
  expect(await f.api().executor.execute({ ...f.input, claimRevision: 5 })).toMatchObject({
    submitted: false,
  });
  expect(f.application.startRun).toHaveBeenCalledTimes(2);
  expect(f.application.startRun.mock.calls[0]![0]).toBe(f.application.startRun.mock.calls[1]![0]);
});

it("recovers an authority submission after a lost tool response", async () => {
  const f = await fixture();
  vi.mocked(f.port.submitDraft).mockImplementationOnce(async () => {
    f.revisions.getDirectKnowledgeDraft.mockResolvedValue(true);
    throw new Error("lost tool response");
  });
  f.port.getDraft = vi.fn(async () => ({
    mode: "summary",
    draft: {
      draftId: f.draftId,
      revision: 2,
      state: "pending_review",
      baseRevision: 0,
      submittedRevision: 2,
    },
    stale: false,
    overlay: {
      files: [{ id: "guide.md" }],
      deletedFiles: [],
      directories: [],
      deletedDirectories: [],
    },
  })) as unknown as KnowledgeRevisionSubmissionPort["getDraft"];
  f.setTurn(async (tools) => {
    const sources = await call(tools, "list_learning_sources", {});
    await call(tools, "select_learning_sources", { handles: [sources.items[0].handle] });
    await call(tools, "knowledge_revision_start", {
      create: { name: "New verified guide", description: "Validated workflow" },
      prompt: "Document the verified workflow.",
    });
    expect(
      await call(tools, "knowledge_revision_submit_draft", {
        draftId: f.draftId,
        expectedRevision: 1,
        summary: "Verified workflow",
      }),
    ).toMatchObject({ code: expect.any(String) });
    expect(
      await call(tools, "knowledge_revision_submit_draft", {
        draftId: f.draftId,
        expectedRevision: 1,
        summary: "Verified workflow",
      }),
    ).toMatchObject({ state: "pending_review", submittedRevision: 2, changedPaths: ["guide.md"] });
  });
  expect(await f.api().executor.execute(f.input)).toMatchObject({ submitted: true });
  expect(f.port.submitDraft).toHaveBeenCalledOnce();
});

it("continues a settled target dependency without admitting another Mission", async () => {
  const f = await fixture();
  const target = {
    storeId: f.targetId,
    name: "Existing",
    description: "Pending review",
    baseRevision: 1,
    snapshotHash: "b".repeat(64),
    mounted: true,
    pending: true,
  };
  f.revisions.listKnowledgeTargets.mockResolvedValue([target]);
  f.setTurn(async (tools) => {
    await call(tools, "finish_memory_learning", {
      disposition: "accumulate",
      reason: "Related target awaits review.",
      waitForTarget: f.targetId,
    });
  });
  await expect(f.api().executor.execute(f.input)).rejects.toThrow("memory_revision_pending");
  expect(f.port.start).not.toHaveBeenCalled();
  f.revisions.listKnowledgeTargets.mockResolvedValue([{ ...target, pending: false }]);
  f.setTurn(async (tools) => {
    await call(tools, "finish_memory_learning", {
      disposition: "duplicate",
      reason: "The reviewed target already contains the result.",
    });
  });
  expect(
    await f.api().executor.execute({ ...f.input, claimRevision: 5, manualRetry: false }),
  ).toMatchObject({ submitted: false, decision: { outcome: "duplicate" } });
  expect(f.application.continueInternalMemoryMission).toHaveBeenCalledOnce();
  expect(new Set(f.application.startRun.mock.calls.map((call) => call[0])).size).toBe(1);
});

it("rejects Skill creation without successful Episode support", async () => {
  const f = await fixture("skill");
  f.setTurn(async (tools) => {
    const sources = await call(tools, "list_learning_sources", {});
    await call(tools, "select_learning_sources", { handles: [sources.items[0].handle] });
    expect(
      await call(tools, "skill_revision_start", {
        create: { name: "Unverified workflow", description: "Unknown success" },
        prompt: "Extract workflow",
      }),
    ).toMatchObject({ code: expect.any(String) });
    await call(tools, "finish_memory_learning", {
      disposition: "unsupported",
      reason: "No validated success.",
    });
  });
  expect(
    await f.api().executor.execute({
      ...f.input,
      sources: f.input.sources.map((source) => ({ ...source, outcome: "failed" as const })),
    }),
  ).toMatchObject({ decision: { outcome: "unsupported" } });
  expect(f.skillPort.start).not.toHaveBeenCalled();
});

it("revokes compiled tools when their failed input is deleted", async () => {
  const f = await fixture();
  await f.api().executor.execute(f.input);
  await f.api().executor.retireJob!(f.input.jobId);
  await expect(call(f.tools(), "list_learning_sources", {})).rejects.toThrow(
    "memory_revision_source_unavailable",
  );
});

it("does not turn a failed target read into a successful no-change verdict", async () => {
  const f = await fixture();
  f.revisions.listKnowledgeTargets.mockResolvedValue([
    {
      storeId: f.targetId,
      name: "Existing",
      description: "Guidance",
      baseRevision: 1,
      snapshotHash: "b".repeat(64),
      mounted: true,
      pending: false,
    },
  ]);
  f.revisions.readKnowledgeTarget.mockRejectedValue(new Error("source storage unavailable"));
  f.setTurn(async (tools) => {
    expect(await call(tools, "read_learning_target", { targetId: f.targetId })).toMatchObject({
      error: "source storage unavailable",
    });
    expect(
      await call(tools, "finish_memory_learning", {
        disposition: "accumulate",
        reason: "Could not read target.",
      }),
    ).toMatchObject({ error: "memory_revision_read_failed" });
  });
  await expect(f.api().executor.execute(f.input)).rejects.toThrow("memory_revision_read_failed");
  expect(f.application.delete).not.toHaveBeenCalled();
});

it("retries an explicitly retryable terminal failure in the original context", async () => {
  const f = await fixture();
  f.setStatus("failed");
  f.application.getTerminalRuntimeFailure.mockResolvedValue({
    code: "provider_overloaded",
    message: "Provider overloaded",
    retryable: true,
    failedAt: new Date().toISOString(),
  });
  await expect(f.api().executor.execute(f.input)).rejects.toMatchObject({
    code: "provider_overloaded",
    retryable: true,
  });
  f.setStatus("succeeded");
  const onAdmission = vi.fn();
  expect(
    await f.api().executor.execute({
      ...f.input,
      claimRevision: 5,
      manualRetry: false,
      retryFailedExecution: true,
      onAdmission,
    }),
  ).toMatchObject({ submitted: false });
  expect(f.application.continueInternalMemoryMission).toHaveBeenCalledOnce();
  expect(onAdmission).toHaveBeenCalledWith(true);
  expect(new Set(f.application.startRun.mock.calls.map((call) => call[0])).size).toBe(1);
});

it("does not admit an already cancelled task", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.api().executor.execute({ ...f.input, signal: controller.signal }),
  ).rejects.toThrow();
  expect(f.application.startRun).not.toHaveBeenCalled();
});

it("releases tool locks before cancelling a retired Native execution", async () => {
  const f = await fixture();
  await f.api().executor.execute(f.input);
  const directory = join(f.root, "state", "memory-direct-revisions-v1");
  const file = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
  const state = JSON.parse(await readFile(join(directory, file), "utf8"));
  state.result = undefined;
  await writeFile(join(directory, file), JSON.stringify(state));
  const missionId = f.application.startRun.mock.calls[0]![0];
  const mission = await f.missions.get(missionId);
  await f.missions.updateExecution(missionId, { ...mission.execution!, status: "running" });
  await expect(f.api().executor.execute(f.input)).rejects.toThrow(
    "memory_revision_observation_pending",
  );
  f.application.interrupt.mockImplementationOnce(async () => {
    await expect(call(f.tools(), "list_learning_sources", {})).rejects.toThrow(
      "memory_revision_source_unavailable",
    );
  });
  await f.api().executor.retireJob!(f.input.jobId);
  expect(f.application.interrupt).toHaveBeenCalledOnce();
});

it("never settles a continuation using the previous execution projection", async () => {
  const f = await fixture();
  f.setStatus("failed");
  await expect(f.api().executor.execute(f.input)).rejects.toThrow(
    "memory_revision_execution_failed",
  );
  const missionId = f.application.startRun.mock.calls[0]![0];
  const previous = (await f.missions.get(missionId)).execution!;
  const nextId = randomUUID();
  f.application.continueInternalMemoryMission.mockResolvedValueOnce({ executionId: nextId });
  await expect(f.api().executor.execute({ ...f.input, claimRevision: 3 })).rejects.toThrow(
    "memory_revision_observation_pending",
  );
  f.reopen();
  await expect(f.api().executor.execute({ ...f.input, claimRevision: 4 })).rejects.toThrow(
    "memory_revision_observation_pending",
  );
  await call(await f.compile(missionId), "finish_memory_learning", {
    disposition: "accumulate",
    reason: "New turn completed without changes.",
  });
  await f.missions.updateExecution(missionId, { ...previous, id: nextId, status: "succeeded" });
  expect(await f.api().executor.execute({ ...f.input, claimRevision: 5 })).toMatchObject({
    decision: { outcome: "accumulate" },
  });
  expect(f.application.continueInternalMemoryMission).toHaveBeenCalledOnce();
});

it.each(["knowledge", "skill"] as const)(
  "does not turn a native %s read failure into a no-change verdict",
  async (kind) => {
    const f = await fixture(kind);
    const port = kind === "knowledge" ? f.port : f.skillPort;
    port.listTargets = vi.fn(async () => {
      throw new Error("authority unavailable");
    });
    f.setTurn(async (tools) => {
      expect(await call(tools, `${kind}_revision_list_targets`, {})).toMatchObject({
        code: expect.any(String),
      });
      expect(
        await call(tools, "finish_memory_learning", {
          disposition: "accumulate",
          reason: "No new supported delta.",
        }),
      ).toMatchObject({ error: "memory_revision_read_failed" });
    });
    await expect(f.api().executor.execute(f.input)).rejects.toThrow("memory_revision_read_failed");
    expect(f.application.delete).not.toHaveBeenCalled();
  },
);

it("reopens an inspected existing Skill draft in the same compiled Mission", async () => {
  const f = await fixture("skill");
  f.revisions.listSkillTargets.mockResolvedValue([
    {
      bindingId: "existing",
      normalizedKeys: ["existing-workflow"],
      capabilityId: f.targetId,
      name: "Existing workflow",
      description: "Verified guidance",
      baseRevision: 1,
      contentHash: "b".repeat(64),
      mounted: true,
      pending: false,
    },
  ]);
  // Restore a durable owned draft whose target disappeared from the current catalog.
  f.setTurn(async (tools) => {
    const sources = await call(tools, "list_learning_sources", {});
    await call(tools, "select_learning_sources", { handles: [sources.items[0].handle] });
    const missionId = f.application.startRun.mock.calls[0]![0];
    const root = join(f.root, "state", "memory-direct-revisions-v1");
    const file = (await readdir(root)).find((name) => name.endsWith(".json"))!;
    const state = JSON.parse(await readFile(join(root, file), "utf8"));
    state.drafts = [
      {
        draftId: f.draftId,
        jobId: randomUUID(),
        targetId: f.targetId,
        name: "Existing workflow",
        operation: "revise",
        sources: [sources.items[0].handle],
        submitted: false,
      },
    ];
    await writeFile(join(root, file), JSON.stringify(state));
    f.revisions.listSkillTargets.mockResolvedValue([]);
    vi.mocked(f.skillPort.start).mockResolvedValueOnce({
      jobId: state.drafts[0].jobId,
      draftId: f.draftId,
      state: "editing",
      target: {
        availability: "ready",
        targetRef: `skill:${f.targetId}`,
        capabilityId: f.targetId,
        name: "Existing workflow",
        description: "Verified guidance",
        revision: 1,
        contentHash: "b".repeat(64),
        mounted: true,
      },
    });
    const resumed = await call(tools, "skill_revision_start", {
      draftId: f.draftId,
      prompt: "Continue the supported change",
    });
    if (resumed.draftId === undefined) throw new Error(JSON.stringify(resumed));
    expect(resumed).toMatchObject({ draftId: f.draftId });
    expect((await f.missions.get(missionId)).origin.type).toBe("system-memory");
  });
  await expect(f.api().executor.execute(f.input)).rejects.toThrow(
    "memory_revision_draft_not_submitted",
  );
  expect(f.skillPort.start).toHaveBeenCalledOnce();
});

it("serializes continuation admission across concurrent observation claims", async () => {
  const f = await fixture();
  f.setStatus("failed");
  await expect(f.api().executor.execute(f.input)).rejects.toThrow(
    "memory_revision_execution_failed",
  );
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.application.continueInternalMemoryMission.mockImplementationOnce(async () => {
    entered();
    await pending;
    return { executionId: randomUUID() };
  });
  const first = f
    .api()
    .executor.execute({ ...f.input, claimRevision: 3 })
    .catch((error: unknown) => error);
  await admitted;
  const second = f
    .api()
    .executor.execute({ ...f.input, claimRevision: 4 })
    .catch((error: unknown) => error);
  release();
  const results = await Promise.all([first, second]);
  for (const result of results)
    expect(result).toMatchObject({ message: "memory_revision_observation_pending" });
  expect(f.application.continueInternalMemoryMission).toHaveBeenCalledOnce();
});

it("recovers a Skill submission receipt before retrying a lost response", async () => {
  const f = await fixture("skill");
  vi.mocked(f.skillPort.submitDraft).mockImplementationOnce(async () => {
    f.revisions.getDirectSkillDraft.mockResolvedValue(true);
    throw new Error("lost tool response");
  });
  f.skillPort.getDraft = vi.fn(async () => ({
    draft: { draftId: f.draftId, jobId: randomUUID(), revision: 2, state: "pending_review" },
  })) as unknown as SkillRevisionSubmissionPort["getDraft"];
  f.setTurn(async (tools) => {
    const sources = await call(tools, "list_learning_sources", {});
    await call(tools, "select_learning_sources", { handles: [sources.items[0].handle] });
    expect(
      await call(tools, "skill_revision_start", {
        create: { name: "New verified guide", description: "Validated workflow" },
        prompt: "Document the verified workflow.",
      }),
    ).toMatchObject({ draftId: f.draftId });
    const input = {
      draftId: f.draftId,
      expectedRevision: 1,
      expectedWorkingTreeHash: "b".repeat(64),
      summary: "Verified workflow",
    };
    expect(await call(tools, "skill_revision_submit_draft", input)).toMatchObject({
      code: expect.any(String),
    });
    expect(await call(tools, "skill_revision_submit_draft", input)).toMatchObject({
      state: "pending_review",
      revision: 2,
    });
  });
  expect(await f.api().executor.execute(f.input)).toMatchObject({ submitted: true });
  expect(f.skillPort.submitDraft).toHaveBeenCalledOnce();
});

it("requires every indexed Expert reservation before admitting more work during observation", async () => {
  const f = await fixture();
  await f.api().executor.execute(f.input);
  expect(await f.api().executor.canObserveJob!(f.input.jobId)).toBe(true);
  await f.api().executor.execute({ ...f.input, expertRef: "expert:0000000000000003" });
  expect(await f.api().executor.canObserveJob!(f.input.jobId)).toBe(true);
  const root = join(f.root, "state", "memory-direct-revisions-v1");
  const files = (await readdir(root)).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(2);
  await rm(join(root, files[1]!));
  f.reopen();
  expect(await f.api().executor.canObserveJob!(f.input.jobId)).toBe(false);
});
