import {
  createKnowledgeMemoryModule,
  createSkillMemoryModule,
  createFileMemoryPolicyStore,
  type MemoryRevisionExecutor,
} from "@pragma/memory";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createStaticRuntimeResolver,
  fingerprintExpertExecutionDefinition,
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
  KnowledgeRevisionToolError,
  type KnowledgeRevisionSubmissionPort,
  type SkillRevisionSubmissionPort,
} from "@pragma/built-in-agents";
import {
  createMissionStore,
  withMissionPreparationFailure,
  type LocalHostSystemExecutorSnapshot,
  type LocalHostMissionApplication,
} from "@pragma/local-host";
import type { PragmaProjectStore } from "@pragma/local-host/deployment";
import { KnowledgeSourceSnapshotSchema, SkillSourceSnapshotSchema } from "@pragma/shared";
import { createMemoryRevisionExecutor } from "./memory-revision-executor.ts";
import type { createMemoryLearningRevisions } from "./memory-learning-revisions.ts";
import { systemExecutorStopSource } from "../missions/system-executor-stop-source.ts";

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

it.each(
  (["knowledge", "skill"] as const).flatMap((kind) =>
    [false, true].map((retryable) => ({ kind, retryable })),
  ),
)(
  "preserves Host retry policy for $kind reads (retryable=$retryable)",
  async ({ kind, retryable }) => {
    const f = await fixture(kind);
    const port = kind === "knowledge" ? f.port : f.skillPort;
    port.listTargets = vi.fn(async () => {
      throw new KnowledgeRevisionToolError(
        "revision_conflict",
        "Host classified this conflict",
        retryable,
      );
    });
    f.setTurn(async (tools) => {
      const result = await call(tools, `${kind}_revision_list_targets`, {});
      expect(result).toMatchObject({ code: "revision_conflict", retryable });
      if (!retryable) expect(result).not.toHaveProperty("recovery");
      await call(tools, "find_learning_targets", {});
    });
    await expect(f.api().executor.execute(f.input)).rejects.toMatchObject({
      code: "revision_conflict",
      retryable,
    });
    f.reopen();
    await expect(
      f.api().executor.execute({ ...f.input, manualRetry: false }),
    ).rejects.toMatchObject({ code: "revision_conflict", retryable });
    expect(f.application.startRun).toHaveBeenCalledOnce();
  },
);

it.each(["knowledge", "skill"] as const)(
  "preserves wrapped %s read corrections at terminal observation",
  async (kind) => {
    const f = await fixture(kind);
    f.setTurn(async (tools) => {
      expect(
        await call(tools, `${kind}_revision_get_draft`, { draftId: randomUUID() }),
      ).toMatchObject({ error: "memory_revision_draft_denied", status: "needs_correction" });
    });
    await expect(f.api().executor.execute(f.input)).rejects.toMatchObject({
      code: "memory_revision_draft_denied",
      retryable: true,
    });
  },
);

it.each(["knowledge", "skill"] as const)(
  "allows %s rediscovery to repair an invalid draft or target handle",
  async (kind) => {
    const f = await fixture(kind);
    const port = kind === "knowledge" ? f.port : f.skillPort;
    port.listDrafts = vi.fn(async () => ({ items: [], nextCursor: undefined }));
    f.setTurn(async (tools) => {
      for (const [name, args] of [
        [`${kind}_revision_get_draft`, { draftId: randomUUID() }],
        ["read_learning_target", { targetId: randomUUID() }],
      ] as const) {
        const feedback = await call(tools, name, args);
        expect(feedback.status).toBe("needs_correction");
        expect(await call(tools, feedback.nextCall.tool, feedback.nextCall.args)).toHaveProperty(
          "items",
        );
      }
      expect(
        await call(tools, "finish_memory_learning", {
          disposition: "accumulate",
          reason:
            "Authorized discovery confirms there is no existing draft or target; the source has no supported new delta.",
        }),
      ).toEqual({ saved: true });
    });
    expect(await f.api().executor.execute(f.input)).toMatchObject({ submitted: false });
  },
);

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
  let pinnedSource: LocalHostSystemExecutorSnapshot | undefined;
  let definitionFingerprint: string | undefined;
  const compileStop = async (missionId: string, useSnapshot = true) => {
    const mission = await missions.get(missionId);
    const ref = kind === "knowledge" ? STORE_REVISION_EXPERT_REF : SKILL_REVISION_EXPERT_REF;
    const stopped = await compileBuiltInAgent({
      ...systemExecutorStopSource(
        {
          ref,
          environmentId: "test",
          definitionStateRoot: join(root, "definitions"),
          workspace: mission.workspace.path,
          pragmaHome: root,
          expertResource: builtInAgentResource(ref),
          rootExecutionOverride: { runtimeId: "fake" },
          adapterHost: {
            environmentId: "test",
            projectRoot: root,
            resolveBinding: async () => {
              throw new Error("Stop must not reopen tools");
            },
            resolveSecret: async () => {
              throw new Error("Stop must not resolve secrets");
            },
            resolveArtifact: async () => {
              throw new Error("Stop must not resolve artifacts");
            },
          },
        },
        useSnapshot ? pinnedSource : undefined,
        mission,
      ),
      compilationPurpose: "stop",
    });
    expect(fingerprintExpertExecutionDefinition(stopped.value)).toBe(definitionFingerprint);
    return stopped;
  };
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
    pinnedSource = {
      expertResource: adapted.expertResource,
      additionalResources: [],
      rootExecutionOverride: { runtimeId: "fake" },
    };
    definitionFingerprint = fingerprintExpertExecutionDefinition(compiled.value);
    const professional = kind === "knowledge" ? "Metadata rules:" : "root-level SKILL.md";
    expect(compiled.value.instructions).toContain(professional);
    expect(compiled.value.instructions).toContain("select_learning_sources");
    expect(compiled.value.instructions).toContain("finish_memory_learning");
    expect(compiled.value.instructions).not.toContain("Interactive revision:");
    expect(compiled.value.instructions).not.toContain("confirm each resolution with the user");
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
    compileStop,
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
    ).toMatchObject({
      code: "invalid_input",
      retryable: true,
      message: expect.stringContaining("memory_revision_target_changed_or_unread"),
      recovery: {
        tool: "read_learning_target",
        reason: expect.stringContaining(target.id),
      },
    });
    expect(
      await call(tools, "read_learning_target", { targetId: target.id, offset: 999999 }),
    ).toMatchObject({ error: "memory_revision_offset_invalid" });
    // A failed content-range read must not satisfy the read-before-start guard.
    expect(
      await call(tools, "knowledge_revision_start", {
        targetRef: target.targetRef,
        prompt: "Add the verified check",
      }),
    ).toMatchObject({ code: "invalid_input", message: "memory_revision_target_changed_or_unread" });
    expect(f.port.start).not.toHaveBeenCalled();
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
    // Publication/version churn after a committed submission must not invalidate its receipt.
    f.revisions.getDirectDraftVersion.mockResolvedValue({
      id: f.targetId,
      revision: 2,
      hash: "c".repeat(64),
    });
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

it.each(["knowledge", "skill"] as const)(
  "repairs all six %s learning tools in the compiled context",
  async (kind) => {
    const f = await fixture(kind);
    if (kind === "knowledge")
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
    else {
      f.revisions.listSkillTargets.mockResolvedValue([
        {
          bindingId: "existing",
          normalizedKeys: ["existing"],
          capabilityId: f.targetId,
          name: "Existing",
          description: "Guidance",
          baseRevision: 1,
          contentHash: "b".repeat(64),
          mounted: true,
          pending: false,
        },
      ]);
      Object.assign(f.revisions, { readSkillTarget: async () => "# Existing skill" });
    }
    f.setTurn(async (tools) => {
      for (const name of ["list_learning_sources", "find_learning_targets"]) {
        expect(await call(tools, name, { offset: -1 })).toMatchObject({
          error: "memory_revision_arguments_invalid",
          status: "needs_correction",
          retryable: true,
        });
        await call(tools, name, {});
      }
      const { items } = await call(tools, "list_learning_sources", {});
      for (const [name, args] of [
        ["read_learning_source", { handle: items[0].handle, offset: 999999 }],
        ["read_learning_target", { targetId: f.targetId, offset: 999999 }],
      ] as const) {
        const feedback = await call(tools, name, args);
        expect(feedback).toMatchObject({
          error: "memory_revision_offset_invalid",
          status: "needs_correction",
          nextCall: { tool: name, args: { offset: 0 } },
        });
        expect(await call(tools, feedback.nextCall.tool, feedback.nextCall.args)).toHaveProperty(
          "text",
        );
      }
      expect(await call(tools, "select_learning_sources", { handles: ["invented"] })).toMatchObject(
        { status: "needs_correction", nextCall: { tool: "list_learning_sources" } },
      );
      await call(tools, "select_learning_sources", { handles: [items[0].handle] });
      expect(
        await call(tools, "finish_memory_learning", {
          disposition: "accumulate",
          reason: "No delta",
          waitForTarget: "invented",
        }),
      ).toMatchObject({ status: "needs_correction", nextCall: { tool: "find_learning_targets" } });
      expect(
        await call(tools, "finish_memory_learning", {
          disposition: "duplicate",
          reason: "Existing guidance already covers the source.",
        }),
      ).toEqual({ saved: true });
    });
    expect(await f.api().executor.execute(f.input)).toMatchObject({
      submitted: false,
      decision: { outcome: "duplicate" },
    });
    expect(f.application.startRun).toHaveBeenCalledOnce();
  },
);

it.each(["knowledge", "skill"] as const)(
  "automatically repairs a missing %s receipt after reopening with the original owner",
  async (kind) => {
    const f = await fixture(kind);
    f.setTurn(async () => undefined);
    await expect(f.api().executor.execute(f.input)).rejects.toMatchObject({
      code: "memory_revision_receipt_missing",
      retryable: true,
      memoryRevisionTransient: true,
    });
    const missionId = f.application.startRun.mock.calls[0]![0];
    f.reopen();
    f.setTurn(async (tools) => {
      await call(tools, "finish_memory_learning", {
        disposition: "accumulate",
        reason: "No supported delta.",
      });
    });
    expect(
      await f.api().executor.execute({
        ...f.input,
        claimRevision: 5,
        manualRetry: false,
        retryFailedExecution: true,
      }),
    ).toMatchObject({ submitted: false });
    expect(f.application.continueInternalMemoryMission).toHaveBeenCalledWith(
      expect.objectContaining({
        id: missionId,
        content: expect.stringContaining("Chat text is not a receipt"),
      }),
    );
    expect(new Set(f.application.startRun.mock.calls.map(([id]) => id)).size).toBe(1);
  },
);

it.each(["knowledge", "skill"] as const)(
  "bounds %s receipt repair to four admissions across scheduler restart",
  async (kind) => {
    const f = await fixture(kind);
    let clock = new Date();
    await createFileMemoryPolicyStore({ pragmaHome: f.root, now: () => clock }).updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    const open = () => {
      const shared = {
        pragmaHome: f.root,
        now: () => clock,
        executor: f.api().executor,
        learningSink: { submit: vi.fn() },
      };
      return kind === "knowledge"
        ? createKnowledgeMemoryModule({
            ...shared,
            sourceReader: { listEligibleSources: async () => f.input.sources },
          })
        : createSkillMemoryModule({
            ...shared,
            sourceReader: {
              listEligibleSources: async () =>
                f.input.sources.map((source) =>
                  SkillSourceSnapshotSchema.parse({ ...source, hasSuccessfulRecovery: false }),
                ),
            },
            targetReader: { listTargets: async () => [] },
          });
    };
    f.setTurn(async () => undefined);
    let module = await open();
    try {
      await module.scheduleRoot(f.input.rootRef);
      for (let attempt = 1; attempt <= 4; attempt++) {
        clock = new Date(clock.getTime() + 24 * 60 * 60_000);
        await module.runBackgroundOnce?.();
        expect((await module.store.listJobs())[0]).toMatchObject({
          attempts: attempt,
          status: attempt === 4 ? "needs_attention" : "pending",
          lastFailure: { code: "memory_revision_receipt_missing", retryable: true },
        });
        module.close();
        f.reopen();
        module = await open();
      }
      clock = new Date(clock.getTime() + 24 * 60 * 60_000);
      await module.runBackgroundOnce?.();
      expect(f.application.startRun).toHaveBeenCalledTimes(4);
      expect(f.application.continueInternalMemoryMission).toHaveBeenCalledTimes(3);
      expect(new Set(f.application.startRun.mock.calls.map(([id]) => id)).size).toBe(1);
      expect(f.application.delete).not.toHaveBeenCalled();
    } finally {
      module.close();
    }
  },
);

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

it.each(["knowledge", "skill"] as const)(
  "replays retired %s cleanup after a failed cold stop using the original definition",
  async (kind) => {
    const f = await fixture(kind);
    await f.api().executor.execute(f.input);
    const directory = join(f.root, "state", "memory-direct-revisions-v1");
    const file = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
    const path = join(directory, file);
    const state = JSON.parse(await readFile(path, "utf8"));
    state.result = undefined;
    await writeFile(path, JSON.stringify(state));
    const missionId = f.application.startRun.mock.calls[0]![0];
    const mission = await f.missions.get(missionId);
    await f.missions.updateExecution(missionId, { ...mission.execution!, status: "running" });
    f.application.delete.mockClear();
    f.application.interrupt.mockRejectedValueOnce(new Error("temporary_stop_failure"));
    await expect(f.api().executor.retireJob!(f.input.jobId)).rejects.toThrow(
      "temporary_stop_failure",
    );
    expect(JSON.parse(await readFile(path, "utf8")).retired).toBe(true);
    expect(f.application.delete).not.toHaveBeenCalled();
    f.reopen();
    f.application.interrupt.mockImplementationOnce(async () => {
      await f.compileStop(missionId);
    });
    await f.api().executor.maintain!([]);
    expect(f.application.interrupt).toHaveBeenCalledTimes(2);
    expect(f.application.delete).toHaveBeenCalledExactlyOnceWith(missionId);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(directory, "jobs"))).toEqual([]);
    expect(f.application.startRun).toHaveBeenCalledOnce();
    expect(f.application.continueInternalMemoryMission).not.toHaveBeenCalled();
  },
);

it.each(["knowledge", "skill"] as const)(
  "rebuilds a historical %s stop definition without a source snapshot",
  async (kind) => {
    const f = await fixture(kind);
    await f.api().executor.execute(f.input);
    await f.compileStop(f.application.startRun.mock.calls[0]![0], false);
    expect(f.application.startRun).toHaveBeenCalledOnce();
  },
);

it("backs off failed retirement commands while preserving the failure and eventual recovery", async () => {
  const f = await fixture();
  await f.api().executor.execute(f.input);
  const missionId = f.application.startRun.mock.calls[0]![0];
  const mission = await f.missions.get(missionId);
  await f.missions.updateExecution(missionId, { ...mission.execution!, status: "running" });
  await f.api().executor.execute({ ...f.input, jobId: randomUUID() });
  const healthyMissionId = f.application.startRun.mock.calls[1]![0];
  f.application.interrupt.mockRejectedValueOnce(new Error("temporary_stop_failure"));
  const realNow = Date.now.bind(Date);
  let clockOffset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  try {
    await expect(f.api().executor.retireJob!(f.input.jobId)).rejects.toThrow(
      "temporary_stop_failure",
    );
    await expect(f.api().executor.maintain!([f.input.jobId])).rejects.toThrow(
      "temporary_stop_failure",
    );
    expect(f.application.delete).toHaveBeenCalledWith(healthyMissionId);
    expect(f.application.interrupt).toHaveBeenCalledExactlyOnceWith(
      missionId,
      mission.execution!.id,
    );
    clockOffset = 5_001;
    await f.api().executor.maintain!([f.input.jobId]);
    expect(f.application.interrupt).toHaveBeenCalledTimes(2);
    expect(f.application.delete).toHaveBeenCalledWith(missionId);
  } finally {
    clock.mockRestore();
  }
});

it("serializes overlapping retirement attempts before checking failure backoff", async () => {
  const f = await fixture();
  await f.api().executor.execute(f.input);
  const missionId = f.application.startRun.mock.calls[0]![0];
  const mission = await f.missions.get(missionId);
  await f.missions.updateExecution(missionId, { ...mission.execution!, status: "running" });
  f.application.delete.mockClear();
  f.application.interrupt.mockRejectedValue(new Error("temporary_stop_failure"));
  const results = await Promise.allSettled([
    f.api().executor.retireJob!(f.input.jobId),
    f.api().executor.retireJob!(f.input.jobId),
  ]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(f.application.interrupt).toHaveBeenCalledOnce();
  expect(f.application.delete).not.toHaveBeenCalled();
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
    await expect(f.api().executor.execute(f.input)).rejects.toThrow("unavailable");
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

it.each([
  ["knowledge", true, false],
  ["skill", true, false],
  ["knowledge", false, false],
  ["skill", false, false],
  ["knowledge", false, true],
  ["skill", false, true],
] as const)(
  "scopes automatic retries to the failed %s Expert (owner present: %s, later Expert failed: %s)",
  async (kind, ownerPresent, failedLater) => {
    const f = await fixture(kind);
    let clock = new Date();
    await createFileMemoryPolicyStore({ pragmaHome: f.root, now: () => clock }).updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    const producerRefs = [
      f.input.rootRef,
      { type: "pragma.expert" as const, id: "0000000000000003" },
    ];
    const knowledgeSource = KnowledgeSourceSnapshotSchema.parse({
      ...f.input.sources[0],
      producerRefs,
    });
    const skillSource = SkillSourceSnapshotSchema.parse({
      ...knowledgeSource,
      hasSuccessfulRecovery: false,
    });
    const execute = vi.fn<MemoryRevisionExecutor["execute"]>((input) =>
      f.api().executor.execute(input),
    );
    const shared = () => ({
      pragmaHome: f.root,
      now: () => clock,
      executor: { ...f.api().executor, execute },
      learningSink: { submit: vi.fn() },
    });
    const open = () =>
      kind === "knowledge"
        ? createKnowledgeMemoryModule({
            ...shared(),
            sourceReader: { listEligibleSources: async () => [knowledgeSource] },
          })
        : createSkillMemoryModule({
            ...shared(),
            sourceReader: { listEligibleSources: async () => [skillSource] },
            targetReader: { listTargets: async () => [] },
          });
    let module = await open();
    f.setStatus("failed");
    if (failedLater)
      f.setTurn(async (tools) => {
        f.setStatus(f.application.startRun.mock.calls.length === 1 ? "succeeded" : "failed");
        await call(tools, "finish_memory_learning", {
          disposition: "accumulate",
          reason: "No supported delta",
        });
      });
    f.application.getTerminalRuntimeFailure.mockResolvedValue({
      code: "provider_overloaded",
      message: "Provider overloaded",
      retryable: true,
      failedAt: clock.toISOString(),
    });
    try {
      await module.scheduleRoot(f.input.rootRef);
      clock = new Date(clock.getTime() + 24 * 60 * 60_000);
      await module.runBackgroundOnce?.();
      expect((await module.store.listJobs())[0]).toMatchObject({
        status: "pending",
        lastFailure: { code: "provider_overloaded", retryable: true },
      });
      expect(f.application.startRun).toHaveBeenCalledTimes(failedLater ? 2 : 1);
      const originalMission = f.application.startRun.mock.calls[failedLater ? 1 : 0]![0];
      module.close();
      if (!ownerPresent) {
        const stateRoot = join(f.root, "state", "memory-direct-revisions-v1");
        const states = await Promise.all(
          (await readdir(stateRoot))
            .filter((name) => name.endsWith(".json"))
            .map(async (name) => ({
              name,
              state: JSON.parse(await readFile(join(stateRoot, name), "utf8")),
            })),
        );
        const file = states.find(({ state }) => state.missionId === originalMission)!.name;
        await rm(join(stateRoot, file));
      }
      f.reopen();
      module = await open();
      f.setStatus("succeeded");
      clock = new Date(clock.getTime() + 24 * 60 * 60_000);
      await module.runBackgroundOnce?.();
      if (ownerPresent) {
        expect((await module.store.listJobs())[0]).toMatchObject({
          status: "completed",
          attempts: 2,
        });
        expect(
          execute.mock.calls.map(([input]) => [input.expertRef, input.retryFailedExecution]),
        ).toEqual([
          ["expert:0000000000000002", false],
          ["expert:0000000000000002", true],
          ["expert:0000000000000003", false],
        ]);
        expect(f.application.continueInternalMemoryMission).toHaveBeenCalledOnce();
        expect(f.application.continueInternalMemoryMission).toHaveBeenCalledWith(
          expect.objectContaining({ id: originalMission }),
        );
        expect(f.application.startRun).toHaveBeenCalledTimes(3);
        expect(new Set(f.application.startRun.mock.calls.map(([id]) => id)).size).toBe(2);
      } else {
        expect((await module.store.listJobs())[0]).toMatchObject({
          status: "needs_attention",
          lastErrorCode: "memory_revision_owner_unconfirmed",
        });
        expect(f.application.startRun).toHaveBeenCalledTimes(failedLater ? 2 : 1);
        expect(f.application.continueInternalMemoryMission).not.toHaveBeenCalled();
      }
    } finally {
      module.close();
    }
  },
);

for (const kind of ["knowledge", "skill"] as const) {
  for (const recoveryMode of ["same-turn", "manual-retry"] as const) {
    it(`${kind} exposes actionable learning errors and recovers by ${recoveryMode} through compiled Host tools`, async () => {
      const f = await fixture(kind);
      const target = {
        name: "Existing guidance",
        description: "Verified workflow",
        baseRevision: 1,
        mounted: true,
        pending: false,
      };
      if (kind === "knowledge")
        f.revisions.listKnowledgeTargets.mockResolvedValue([
          { ...target, storeId: f.targetId, snapshotHash: "b".repeat(64) },
        ]);
      else
        f.revisions.listSkillTargets.mockResolvedValue([
          {
            ...target,
            bindingId: "existing",
            normalizedKeys: [],
            capabilityId: f.targetId,
            contentHash: "b".repeat(64),
          },
        ]);
      // Both authority readers return actual content; discovery alone is insufficient.
      Object.assign(f.revisions, { readSkillTarget: vi.fn(async () => "# Existing guidance") });
      const recover = async (tools: Tool[]) => {
        const catalog = await call(tools, "find_learning_targets", {});
        const item = catalog.items[0];
        expect(await call(tools, "read_learning_target", { targetId: item.id })).toMatchObject({
          text: expect.any(String),
        });
        const sources = await call(tools, "list_learning_sources", {});
        await call(tools, "read_learning_source", { handle: sources.items[0].handle });
        await call(tools, "select_learning_sources", { handles: [sources.items[0].handle] });
        expect(
          await call(tools, `${kind}_revision_start`, {
            targetRef: item.targetRef,
            prompt: "Add verified check",
          }),
        ).toMatchObject({ draftId: f.draftId });
        expect(
          await call(tools, `${kind}_revision_submit_draft`, {
            draftId: f.draftId,
            expectedRevision: 1,
            summary: "Add verified check",
            ...(kind === "skill" ? { expectedWorkingTreeHash: "c".repeat(64) } : {}),
          }),
        ).toMatchObject({ state: "pending_review" });
      };
      f.setTurn(async (tools) => {
        const item = (await call(tools, "find_learning_targets", {})).items[0];
        if (kind === "skill") {
          expect(
            await call(tools, "read_learning_target", { targetId: `skill:${item.id}` }),
          ).toMatchObject({
            error: "memory_revision_target_denied",
            recovery: { tool: "find_learning_targets" },
          });
          expect(
            await call(tools, `${kind}_revision_start`, {
              targetRef: item.targetRef,
              prompt: "Add check",
            }),
          ).toMatchObject({
            code: "invalid_input",
            message: "memory_revision_sources_required",
            recovery: { tool: "select_learning_sources" },
          });
        } else {
          const source = (await call(tools, "list_learning_sources", {})).items[0];
          await call(tools, "read_learning_source", { handle: source.handle });
          await call(tools, "select_learning_sources", { handles: [source.handle] });
          expect(
            await call(tools, `${kind}_revision_start`, {
              targetRef: item.targetRef,
              prompt: "Add check",
            }),
          ).toMatchObject({
            code: "invalid_input",
            message: "memory_revision_target_changed_or_unread",
            recovery: { tool: "read_learning_target" },
          });
        }
        expect(kind === "knowledge" ? f.port.start : f.skillPort.start).not.toHaveBeenCalled();
        if (recoveryMode === "same-turn") await recover(tools);
      });
      if (recoveryMode === "manual-retry") {
        await expect(f.api().executor.execute(f.input)).rejects.toThrow(
          kind === "knowledge"
            ? "memory_revision_target_changed_or_unread"
            : "memory_revision_target_denied",
        );
        const originalMission = f.application.startRun.mock.calls[0]![0];
        f.reopen();
        f.setTurn(recover);
        expect(await f.api().executor.execute({ ...f.input, claimRevision: 5 })).toMatchObject({
          submitted: true,
        });
        expect(f.application.continueInternalMemoryMission).toHaveBeenCalledWith(
          expect.objectContaining({ id: originalMission }),
        );
      } else expect(await f.api().executor.execute(f.input)).toMatchObject({ submitted: true });
    });
  }
}

for (const kind of ["knowledge", "skill"] as const) {
  for (const prerequisite of ["sources", "target"] as const) {
    for (const manualRetry of [false, true]) {
      it(`${kind} can finish without a draft after correcting ${prerequisite}, manual retry=${manualRetry}`, async () => {
        const f = await fixture(kind);
        const target = {
          name: "Existing guidance",
          description: "Verified workflow",
          baseRevision: 1,
          mounted: true,
          pending: false,
        };
        if (kind === "knowledge")
          f.revisions.listKnowledgeTargets.mockResolvedValue([
            { ...target, storeId: f.targetId, snapshotHash: "b".repeat(64) },
          ]);
        else
          f.revisions.listSkillTargets.mockResolvedValue([
            {
              ...target,
              bindingId: "existing",
              normalizedKeys: [],
              capabilityId: f.targetId,
              contentHash: "b".repeat(64),
            },
          ]);
        Object.assign(f.revisions, { readSkillTarget: vi.fn(async () => "# Existing guidance") });
        const selectSources = async (tools: Tool[]) => {
          const source = (await call(tools, "list_learning_sources", {})).items[0];
          await call(tools, "read_learning_source", { handle: source.handle });
          return call(tools, "select_learning_sources", { handles: [source.handle] });
        };
        const correctAndFinish = async (tools: Tool[]) => {
          if (prerequisite === "sources") await selectSources(tools);
          else await call(tools, "read_learning_target", { targetId: f.targetId });
          expect(
            await call(tools, "finish_memory_learning", {
              disposition: "duplicate",
              reason: "After reading, the existing asset already covers this evidence.",
            }),
          ).toMatchObject({ saved: true });
        };
        f.setTurn(async (tools) => {
          const item = (await call(tools, "find_learning_targets", {})).items[0];
          if (prerequisite === "target") await selectSources(tools);
          expect(
            await call(tools, `${kind}_revision_start`, {
              targetRef: item.targetRef,
              prompt: "Check incremental revision",
            }),
          ).toMatchObject({
            message:
              prerequisite === "sources"
                ? "memory_revision_sources_required"
                : "memory_revision_target_changed_or_unread",
          });
          // An unresolved precondition must still block a no-change receipt.
          expect(
            await call(tools, "finish_memory_learning", {
              disposition: "duplicate",
              reason: "Not yet corrected.",
            }),
          ).toMatchObject({ error: "memory_revision_read_failed" });
          if (!manualRetry) await correctAndFinish(tools);
        });
        if (manualRetry) {
          await expect(f.api().executor.execute(f.input)).rejects.toThrow(
            prerequisite === "sources"
              ? "memory_revision_sources_required"
              : "memory_revision_target_changed_or_unread",
          );
          f.reopen();
          f.setTurn(correctAndFinish);
        }
        expect(
          await f.api().executor.execute({ ...f.input, claimRevision: manualRetry ? 5 : 2 }),
        ).toMatchObject({ submitted: false, decision: { outcome: "duplicate" } });
        expect(kind === "knowledge" ? f.port.start : f.skillPort.start).not.toHaveBeenCalled();
        expect(f.application.continueInternalMemoryMission).toHaveBeenCalledTimes(
          manualRetry ? 1 : 0,
        );
      });
    }
  }
  it(`retains the concrete ${kind} authority read failure in task diagnostics`, async () => {
    const f = await fixture(kind);
    const port = kind === "knowledge" ? f.port : f.skillPort;
    port.listTargets = vi.fn(async () => {
      throw Object.assign(new Error("The target cannot be read in this scope."), {
        code: "permission_denied",
      });
    });
    f.setTurn(async (tools) => {
      expect(await call(tools, `${kind}_revision_list_targets`, {})).toMatchObject({
        code: "permission_denied",
      });
      expect(
        await call(tools, "finish_memory_learning", {
          disposition: "duplicate",
          reason: "Cannot verify coverage.",
        }),
      ).toMatchObject({ error: "memory_revision_read_failed" });
    });
    await expect(f.api().executor.execute(f.input)).rejects.toThrow("permission_denied");
    expect(f.application.delete).not.toHaveBeenCalled();
    const originalMission = f.application.startRun.mock.calls[0]![0];
    port.listTargets = vi.fn(async () => ({ items: [] }));
    f.reopen();
    f.setTurn(async (tools) => {
      expect(await call(tools, `${kind}_revision_list_targets`, {})).toMatchObject({ items: [] });
      expect(
        await call(tools, "finish_memory_learning", {
          disposition: "accumulate",
          reason: "Access restored; no valuable change.",
        }),
      ).toMatchObject({ saved: true });
    });
    expect(await f.api().executor.execute({ ...f.input, claimRevision: 5 })).toMatchObject({
      submitted: false,
      decision: { outcome: "accumulate" },
    });
    expect(f.application.continueInternalMemoryMission).toHaveBeenCalledWith(
      expect.objectContaining({ id: originalMission }),
    );
  });
}
