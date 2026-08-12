import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import {
  MemoryEvidenceEnvelopeSchema,
  type MemoryEvidenceEnvelope,
  type MemorySubjectRef,
} from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const failureDiagnostic = (code: string) =>
  ({
    schemaVersion: "pragma.memory-extraction-failure/v1",
    code,
    message: code,
    phase: "storage",
    failedAt: "2026-08-01T00:00:00.000Z",
  }) as const;

import {
  createEpisodicMemoryModule,
  createFederatedMemoryContextStore,
  MEMORY_CURATOR_REF,
  MemoryModuleRegistry,
  type EpisodicExtractionInput,
  type EpisodicMemoryExtractor,
  type MemoryRecallScope,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Episodic Memory", () => {
  it("extracts a layered, evidence-traceable episode without WorkingState", async () => {
    const root = await temporaryRoot();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor,
      now: () => now,
    });
    const evidence = executionEvidence("execution-a");

    await module.consume(evidence);
    await module.runBackgroundOnce?.();

    const episodes = await module.store.list();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      executionId: "execution-a",
      revision: 1,
      language: "zh-Hans",
      outcome: { status: "succeeded" },
    });
    expect(extractor.extract).toHaveBeenCalledOnce();
    expect((await module.store.listExtractionJobs())[0]?.completedAt).toBe(now.toISOString());
    const readEvidence = vi.spyOn(module.store, "readEvidence");
    const getEvidence = vi.spyOn(module.store, "getEvidenceForRecall");

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: () => expertScope("expert-a"),
    });
    const listed = await context.listContext({});
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual([
      "episodic/index.md",
      "episodic/summary.md",
      "guide.md",
      "overview.md",
    ]);
    const overview = await context.readContext({ id: "overview.md" });
    expect(overview.ok && overview.value.content).toContain("Episodic Memory Summary");
    const detail = await context.readContext({ id: `episodic/items/${episodes[0]!.id}.md` });
    expect(detail.ok && detail.value.content).toContain("## Evidence");
    expect(overview.ok && overview.value.content).toContain(
      `(episodic/items/${episodes[0]!.id}.md)`,
    );
    expect(detail.ok && detail.value.content).toContain("(episodic/evidence/");
    expect(readEvidence).not.toHaveBeenCalled();
    expect(getEvidence).not.toHaveBeenCalled();
    await expect(
      context.readContext({ id: `episodic/evidence/${evidence[0]!.messageId}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    const evidenceDetail = await context.readContext({
      id: `episodic/evidence/${evidence.at(-1)!.messageId}.md`,
    });
    expect(evidenceDetail.ok && evidenceDetail.value.content).toContain("succeeded");
    expect(getEvidence).toHaveBeenCalledTimes(2);
    const search = await context.searchContext({ query: evidence[0]!.messageId });
    expect(search.ok && search.value.some((match) => match.id.includes("/evidence/"))).toBe(false);
    module.close();
  });

  it("escapes episode goals used as Markdown link labels", async () => {
    const goal = "Click](https://example.com)[Episode";
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(undefined, 0.9, goal),
    });
    await module.consume(executionEvidence("markdown-link-label"));
    await module.runBackgroundOnce?.();

    const [episode] = await module.store.list();
    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = scopedContext(registry, expertScope("expert-a"));
    const expectedLink = `[Click\\](https://example.com)\\[Episode](episodic/items/${episode!.id}.md)`;
    for (const id of ["episodic/summary.md", "episodic/index.md"]) {
      const item = await context.readContext({ id });
      expect(item.ok && item.value.content).toContain(expectedLink);
    }
    module.close();
  });

  it("fails closed when recall is disabled for the current asset", async () => {
    const registry = new MemoryModuleRegistry();
    const module = await createEpisodicMemoryModule({ pragmaHome: await temporaryRoot() });
    registry.register(module);
    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: (runContext) =>
        runContext?.source?.id === undefined || runContext.source.id === "blocked-expert"
          ? undefined
          : expertScope("expert-a"),
    });
    const runContext = { source: { type: "pragma.expert", id: "blocked-expert" } };

    await expect(context.listContext({ context: runContext })).resolves.toEqual({
      ok: true,
      value: [],
    });
    await expect(
      context.readContext({ id: "overview.md", context: runContext }),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
    await expect(context.listContext({})).resolves.toEqual({ ok: true, value: [] });
    await expect(context.searchContext({ query: "anything" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    module.close();
  });

  it("keeps only the three most recent Episodes in the bounded summary", async () => {
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(),
    });
    for (const executionId of ["episode-one", "episode-two", "episode-three", "episode-four"]) {
      await module.consume(executionEvidence(executionId));
      await module.runBackgroundOnce?.();
    }
    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = scopedContext(registry, expertScope("expert-a"));
    const summary = await context.readContext({ id: "episodic/summary.md" });

    expect(summary.ok && summary.value.content.match(/episodic\/items\//gu)?.length).toBe(3);
    module.close();
  });

  it("keeps low-score episodes out of index while deep search can recall them", async () => {
    let clock = new Date("2026-08-02T00:00:00.000Z");
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(undefined, 0),
      now: () => clock,
    });
    await module.consume(executionEvidence("deep-archive-marker"));
    await module.runBackgroundOnce?.();
    expect(await module.store.list()).toHaveLength(1);
    clock = new Date("2028-08-01T00:00:00.000Z");

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: () => expertScope("expert-a"),
    });
    const index = await context.readContext({ id: "episodic/index.md" });
    expect(index.ok && index.value.content).not.toContain("deep-archive-marker");
    const search = await context.searchContext({ query: "deep-archive-marker" });
    expect(search.ok && search.value.some((item) => item.id.startsWith("episodic/items/"))).toBe(
      true,
    );
    module.close();
  });

  it("isolates personal stores while combining the current Team or Flow store with the current Expert", async () => {
    const root = await temporaryRoot();
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
    });
    const cases = [
      {
        executionId: "personal-a",
        rootRef: ref("pragma.expert", "expert-a"),
        producerRefs: [ref("pragma.expert", "expert-a")],
      },
      {
        executionId: "personal-b",
        rootRef: ref("pragma.expert", "expert-b"),
        producerRefs: [ref("pragma.expert", "expert-b")],
      },
      {
        executionId: "team-a",
        rootRef: ref("pragma.expert-team", "team-t"),
        producerRefs: [ref("pragma.expert", "expert-a")],
      },
      {
        executionId: "flow-a",
        rootRef: ref("pragma.flow", "flow-f"),
        producerRefs: [ref("pragma.expert", "expert-a")],
      },
    ];
    for (const item of cases) {
      await module.consume(executionEvidence(item.executionId, item.rootRef, item.producerRefs));
      await module.runBackgroundOnce?.();
    }
    const records = await module.store.list();
    const byExecution = new Map(records.map((record) => [record.executionId, record]));
    expect(byExecution.get("team-a")).toMatchObject({
      rootRefs: [{ type: "pragma.expert-team", id: "team-t" }],
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
      bindings: [
        {
          consumerRef: { type: "pragma.expert-team", id: "team-t" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
    });

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const personalA = scopedContext(registry, expertScope("expert-a"));
    const personalIndex = await personalA.readContext({ id: "episodic/index.md" });
    expect(personalIndex.ok && personalIndex.value.content).toContain("personal-a");
    expect(personalIndex.ok && personalIndex.value.content).not.toMatch(/personal-b|team-a|flow-a/);

    const teamA = scopedContext(registry, {
      rootRef: ref("pragma.expert-team", "team-t"),
      expertRef: ref("pragma.expert", "expert-a"),
    });
    const teamIndex = await teamA.readContext({ id: "episodic/index.md" });
    expect(teamIndex.ok && teamIndex.value.content).toMatch(/team-a[\s\S]*personal-a/);
    expect(teamIndex.ok && teamIndex.value.content).not.toMatch(/personal-b|flow-a/);
    expect(teamIndex.ok && teamIndex.value.content).toContain("— current-asset");
    expect(teamIndex.ok && teamIndex.value.content).toContain("— personal");

    const teamOnly = scopedContext(registry, {
      rootRef: ref("pragma.expert-team", "team-t"),
    });
    const teamOnlyIndex = await teamOnly.readContext({ id: "episodic/index.md" });
    expect(teamOnlyIndex.ok && teamOnlyIndex.value.content).toContain("team-a");
    expect(teamOnlyIndex.ok && teamOnlyIndex.value.content).not.toMatch(
      /personal-a|personal-b|flow-a/,
    );
    expect(teamOnlyIndex.ok && teamOnlyIndex.value.content).not.toContain("— personal");
    const teamOnlyGuide = await teamOnly.readContext({ id: "guide.md" });
    expect(teamOnlyGuide.ok && teamOnlyGuide.value.content).toContain(
      "no Expert personal Store is included",
    );
    expect(teamOnlyGuide.ok && teamOnlyGuide.value.content).not.toContain(
      "combines the root execution asset with the current Expert's personal Store",
    );

    const foreign = byExecution.get("personal-b")!;
    await expect(
      teamA.readContext({ id: `episodic/items/${foreign.id}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    const foreignEvidence = executionEvidence("personal-b", ref("pragma.expert", "expert-b"), [
      ref("pragma.expert", "expert-b"),
    ])[0]!;
    await expect(
      teamA.readContext({ id: `episodic/evidence/${foreignEvidence.messageId}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    await expect(teamA.searchContext({ query: "personal-b" })).resolves.toMatchObject({
      ok: true,
      value: [],
    });

    const flowA = scopedContext(registry, {
      rootRef: ref("pragma.flow", "flow-f"),
      expertRef: ref("pragma.expert", "expert-a"),
    });
    const flowIndex = await flowA.readContext({ id: "episodic/index.md" });
    expect(flowIndex.ok && flowIndex.value.content).toMatch(/flow-a[\s\S]*personal-a/);
    expect(flowIndex.ok && flowIndex.value.content).not.toMatch(/personal-b|team-a/);
    module.close();
  });

  it("is idempotent on replay and revises the same episode for a later terminal event", async () => {
    const root = await temporaryRoot();
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({ pragmaHome: root, extractor });
    const evidence = executionEvidence("execution-b");
    await module.consume(evidence);
    await module.runBackgroundOnce?.();
    simulateJobCompletionCrash(root);
    await module.runBackgroundOnce?.();
    expect((await module.store.list())[0]?.revision).toBe(1);
    expect(extractor.extract).toHaveBeenCalledTimes(1);

    const data = new DatabaseSync(
      join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.episodic"),
        "episodes.sqlite",
      ),
    );
    expect(
      data
        .prepare(
          "SELECT execution_id AS executionId FROM episode_source_executions ORDER BY execution_id",
        )
        .all(),
    ).toEqual([{ executionId: "execution-b" }]);
    data.close();

    await module.consume(evidence);
    await module.runBackgroundOnce?.();
    expect((await module.store.list())[0]?.revision).toBe(1);
    expect(extractor.extract).toHaveBeenCalledTimes(1);

    const later = terminalEvidence("execution-b", "terminal-later", "2026-08-01T01:00:00.000Z");
    await module.consume([later]);
    await module.runBackgroundOnce?.();
    expect((await module.store.list())[0]?.revision).toBe(2);
    expect(extractor.extract).toHaveBeenCalledTimes(2);
    module.close();
  });

  it("releases a claimed job when persisted Evidence cannot be decoded", async () => {
    const root = await temporaryRoot();
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    });
    await module.consume(executionEvidence("execution-corrupt"));
    const state = new DatabaseSync(
      join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot("pragma.memory.episodic"),
        "jobs.sqlite",
      ),
    );
    state
      .prepare("UPDATE evidence SET envelope_json = '{}' WHERE execution_id = ?")
      .run("execution-corrupt");
    state.close();

    await module.runBackgroundOnce?.();

    await expect(module.store.listExtractionJobs()).resolves.toEqual([
      expect.objectContaining({ status: "pending", attempts: 1 }),
    ]);
    module.close();
  });

  it("waits for six idle hours, resets the deadline on new Mission activity, and aggregates turns", async () => {
    let clock = new Date("2026-08-01T00:00:03.000Z");
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
      now: () => clock,
    });
    const conversationRef = ref("pragma.mission", "mission-idle");
    await module.consume(
      executionEvidence("idle-turn-1").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    await module.runBackgroundOnce?.();
    expect(extractor.extract).not.toHaveBeenCalled();
    expect((await module.store.listExtractionJobs())[0]).toMatchObject({
      status: "waiting_idle",
      conversationRef,
      sourceExecutionIds: ["idle-turn-1"],
    });

    clock = new Date("2026-08-01T05:59:00.000Z");
    const second = executionEvidence("idle-turn-2").map((item) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...item,
        conversationRef,
        occurredAt:
          item.topic === "execution.execution.terminal"
            ? "2026-08-01T05:59:00.000Z"
            : "2026-08-01T05:58:59.000Z",
      }),
    );
    await module.consume(second);
    clock = new Date("2026-08-01T11:58:59.000Z");
    await module.runBackgroundOnce?.();
    expect(extractor.extract).not.toHaveBeenCalled();

    clock = new Date("2026-08-01T11:59:01.000Z");
    await module.runBackgroundOnce?.();
    expect(extractor.extract).toHaveBeenCalledOnce();
    expect(extractor.extract.mock.calls[0]?.[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ correlationId: "idle-turn-1" }),
        expect.objectContaining({ correlationId: "idle-turn-2" }),
      ]),
    );
    expect((await module.store.list())[0]).toMatchObject({
      conversationRef,
      sourceExecutionIds: ["idle-turn-1", "idle-turn-2"],
      revision: 1,
    });
    module.close();
  });

  it("expedites, interrupts, and deletes a user-managed extraction job", async () => {
    const root = await temporaryRoot();
    const module = await createEpisodicMemoryModule({ pragmaHome: root });
    const now = new Date("2026-08-05T08:00:00.000Z");
    const conversationRef = ref("pragma.mission", "mission-managed");
    await module.consume(
      executionEvidence("managed-execution").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    const [waiting] = await module.store.listExtractionJobs();
    await module.store.expediteJob({ id: waiting!.id, expectedRevision: waiting!.revision, now });
    const claimed = await module.store.claimDueJob(now);
    expect(claimed?.status).toBe("running");

    const interrupted = await module.store.interruptJob({
      id: claimed!.id,
      expectedRevision: claimed!.revision,
      now,
    });
    expect(interrupted).toMatchObject({
      status: "waiting_idle",
      eligibleAt: "2026-08-05T14:00:00.000Z",
      retryAt: "2026-08-05T14:00:00.000Z",
    });

    await module.store.expediteJob({
      id: interrupted.id,
      expectedRevision: interrupted.revision,
      now,
    });
    const reclaimed = await module.store.claimDueJob(now);
    await module.store.fail({
      job: reclaimed!,
      diagnostic: failureDiagnostic("memory_extractor_profile_invalid"),
      retry: "configuration",
      now,
    });
    const [attention] = await module.store.listExtractionJobs();
    expect(attention).toMatchObject({
      lastErrorMessage: "memory_extractor_profile_invalid",
      lastFailure: { code: "memory_extractor_profile_invalid" },
    });
    expect(await module.store.listFailureAttempts(attention!.id)).toHaveLength(1);
    await module.store.deleteJob({
      id: attention!.id,
      expectedRevision: attention!.revision,
      now,
    });
    expect(await module.store.listExtractionJobs()).toEqual([]);
    expect(await module.store.listFailureAttempts(attention!.id)).toEqual([]);
    expect(await module.store.readEvidence("managed-execution")).toEqual([]);
    module.close();
  });

  it("merges an execution-scoped fallback job when the Mission binding arrives", async () => {
    const module = await createEpisodicMemoryModule({ pragmaHome: await temporaryRoot() });
    const conversationRef = ref("pragma.mission", "mission-late-binding");
    await module.consume(
      executionEvidence("bound-turn").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    await module.consume(executionEvidence("fallback-turn"));
    expect(await module.store.listExtractionJobs()).toHaveLength(2);

    await module.bindExecutionConversation({
      executionId: "fallback-turn",
      conversationRef,
      now: new Date("2026-08-01T00:01:00.000Z"),
    });

    await expect(module.store.listExtractionJobs()).resolves.toEqual([
      expect.objectContaining({
        conversationRef,
        sourceExecutionIds: ["bound-turn", "fallback-turn"],
      }),
    ]);
    module.close();
  });

  it("allows completed Missions immediately and rejects a superseded running result", async () => {
    let clock = new Date("2026-08-01T00:00:03.000Z");
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fakeExtractor();
    let signal: AbortSignal | undefined;
    const extractor: EpisodicMemoryExtractor & { extract: ReturnType<typeof vi.fn> } = {
      extract: vi.fn(async (input, options) => {
        signal = options?.signal;
        await released;
        return await base.extract(input);
      }),
    };
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
      now: () => clock,
    });
    const conversationRef = ref("pragma.mission", "mission-superseded");
    await module.setConversationState({ conversationRef, state: "completed", now: clock });
    await module.consume(
      executionEvidence("superseded-turn").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    const running = module.runBackgroundOnce?.();
    await vi.waitFor(() => expect(extractor.extract).toHaveBeenCalledOnce());
    clock = new Date("2026-08-01T00:01:00.000Z");
    await module.setConversationState({ conversationRef, state: "active", now: clock });
    expect(signal?.aborted).toBe(true);
    release();
    await running;
    expect(await module.store.list()).toEqual([]);
    expect((await module.store.listExtractionJobs())[0]).toMatchObject({
      status: "waiting_idle",
      attempts: 0,
    });
    module.close();
  });

  it("rechecks the conversation watermark before invoking the extractor", async () => {
    const clock = new Date("2026-08-01T00:00:03.000Z");
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
      now: () => clock,
    });
    const conversationRef = ref("pragma.mission", "mission-preflight-superseded");
    await module.setConversationState({ conversationRef, state: "completed", now: clock });
    await module.consume(
      executionEvidence("preflight-turn").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    const readEvidence = module.store.readEvidenceForJob.bind(module.store);
    vi.spyOn(module.store, "readEvidenceForJob").mockImplementationOnce(async (job) => {
      const evidence = await readEvidence(job);
      await module.setConversationState({
        conversationRef,
        state: "active",
        now: new Date("2026-08-01T00:01:00.000Z"),
      });
      return evidence;
    });

    await module.runBackgroundOnce?.();

    expect(extractor.extract).not.toHaveBeenCalled();
    expect((await module.store.listExtractionJobs())[0]).toMatchObject({
      status: "waiting_idle",
      attempts: 0,
    });
    module.close();
  });

  it("persists a running-Execution claim barrier across restart", async () => {
    const root = await temporaryRoot();
    const conversationRef = ref("pragma.mission", "mission-running");
    const module = await createEpisodicMemoryModule({ pragmaHome: root });
    await module.consume(
      executionEvidence("long-running-turn").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    await module.setConversationState({
      conversationRef,
      state: "running",
      now: new Date("2026-08-01T01:00:00.000Z"),
    });
    module.close();

    const reopened = await createEpisodicMemoryModule({ pragmaHome: root });
    await expect(
      reopened.store.claimDueJob(new Date("2026-08-03T00:00:00.000Z")),
    ).resolves.toBeUndefined();
    await reopened.setConversationState({
      conversationRef,
      state: "active",
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    await expect(
      reopened.store.claimDueJob(new Date("2026-08-03T05:59:59.000Z")),
    ).resolves.toBeUndefined();
    await expect(
      reopened.store.claimDueJob(new Date("2026-08-03T06:00:00.000Z")),
    ).resolves.toMatchObject({ status: "running", conversationRef });
    reopened.close();
  });

  it("only tightens recall permissions and forgets content without allowing replay to recreate it", async () => {
    const root = await temporaryRoot();
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
    });
    const evidence = executionEvidence("execution-governance");
    await module.consume(evidence);
    await module.runBackgroundOnce?.();
    const initial = (await module.store.list())[0]!;
    const actorRef = ref("pragma.user", "local-user");
    const tightened = await module.store.tightenAccess({
      id: initial.id,
      expectedRevision: initial.revision,
      actorRef,
      reason: "Keep this episode out of recall.",
      bindings: initial.bindings.map((binding) => ({
        ...binding,
        recall: "deny" as const,
        permissionRevision: binding.permissionRevision + 1,
      })),
      now: new Date("2026-08-03T12:00:00.000Z"),
    });
    await expect(
      module.store.tightenAccess({
        id: tightened.id,
        expectedRevision: tightened.revision,
        actorRef,
        reason: "Attempt to expand recall.",
        bindings: tightened.bindings.map((binding) => ({
          ...binding,
          recall: "allow" as const,
          permissionRevision: binding.permissionRevision + 1,
        })),
        now: new Date("2026-08-03T12:01:00.000Z"),
      }),
    ).rejects.toThrow("memory_permission_expansion_denied");
    expect(await module.store.listForRecall(expertScope("expert-a"))).toEqual([]);
    expect(await module.store.history(initial.id)).toHaveLength(2);
    expect(await module.store.getEvidence(evidence.at(-1)!.messageId)).toBeDefined();

    await expect(
      module.store.forget({
        id: tightened.id,
        expectedRevision: tightened.revision,
        actorRef: null as unknown as MemorySubjectRef,
        reason: "Malformed governance actor.",
        now: new Date("2026-08-03T12:01:30.000Z"),
      }),
    ).rejects.toThrow();
    expect(await module.store.get(initial.id)).toBeDefined();

    const dataPath = join(
      new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.episodic"),
      "episodes.sqlite",
    );
    const cleanupFixtureAt = "2026-08-03T12:01:45.000Z";
    const cleanupFixture = new DatabaseSync(dataPath);
    cleanupFixture
      .prepare(
        `INSERT OR REPLACE INTO memory_index(
          memory_id, consumer_key, tier, score, recall_count, last_recalled_at, computed_at
        ) VALUES (?, ?, 'archived', 0.1, 1, ?, ?)`,
      )
      .run(initial.id, "pragma.expert\0expert-a", cleanupFixtureAt, cleanupFixtureAt);
    cleanupFixture
      .prepare(
        `INSERT OR REPLACE INTO revision_prune_audit(
          memory_id, pruned_through_revision, pruned_count, pruned_at
        ) VALUES (?, 1, 1, ?)`,
      )
      .run(initial.id, cleanupFixtureAt);
    cleanupFixture.close();

    await module.store.forget({
      id: tightened.id,
      expectedRevision: tightened.revision,
      actorRef,
      reason: "User requested forgetting.",
      now: new Date("2026-08-03T12:02:00.000Z"),
    });
    expect(await module.store.get(initial.id)).toBeUndefined();
    expect(await module.store.history(initial.id)).toEqual([]);
    expect(await module.store.getEvidence(evidence.at(-1)!.messageId)).toBeUndefined();

    await module.consume([
      terminalEvidence("execution-governance", "terminal-after-forget", "2026-08-03T12:03:00.000Z"),
    ]);
    await module.runBackgroundOnce?.();
    expect(await module.store.list()).toEqual([]);
    module.close();

    const database = new DatabaseSync(dataPath);
    const tombstone = database
      .prepare("SELECT tombstone_json AS value FROM tombstones WHERE id = ?")
      .get(initial.id) as { readonly value: string };
    const governance = database
      .prepare("SELECT COUNT(*) AS count FROM governance_events WHERE episode_id = ?")
      .get(initial.id) as { readonly count: number };
    const memoryIndex = database
      .prepare("SELECT COUNT(*) AS count FROM memory_index WHERE memory_id = ?")
      .get(initial.id) as { readonly count: number };
    const pruneAudit = database
      .prepare("SELECT COUNT(*) AS count FROM revision_prune_audit WHERE memory_id = ?")
      .get(initial.id) as { readonly count: number };
    database.close();
    expect(governance.count).toBe(0);
    expect(memoryIndex.count).toBe(0);
    expect(pruneAudit.count).toBe(0);
    expect(tombstone.value).not.toMatch(
      /Repair|goal|summary|evidenceRefs|Keep this episode|User requested forgetting/,
    );
  });

  it("upgrades a historical episodic v1 database to revision bindings", async () => {
    const root = await temporaryRoot();
    const dataRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot(
      "pragma.memory.episodic",
    );
    await mkdir(dataRoot, { recursive: true });
    const database = new DatabaseSync(join(dataRoot, "episodes.sqlite"));
    database.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const historical = JSON.parse(
      await readFile(new URL("./fixtures/episodic-v1-record.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    database
      .prepare(
        "INSERT INTO episodes(id, execution_id, revision, status, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        historical["id"] as string,
        historical["executionId"] as string,
        historical["revision"] as number,
        historical["status"] as string,
        historical["updatedAt"] as string,
        JSON.stringify(historical),
      );
    database.close();

    const module = await createEpisodicMemoryModule({ pragmaHome: root });
    expect((await module.store.list())[0]).toMatchObject({
      schemaVersion: "pragma.memory-episodic/v3",
      bindings: [
        {
          consumerRef: { type: "pragma.expert", id: "expert-a" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
    });
    const backup = new DatabaseSync(join(dataRoot, "episodes.sqlite.v1.backup"));
    expect(
      (backup.prepare("PRAGMA user_version").get() as unknown as { readonly user_version: number })
        .user_version,
    ).toBe(1);
    backup.close();
    module.close();
  });

  it("rejects low-value and restricted evidence without invoking the model", async () => {
    for (const sensitivity of ["confidential", "restricted"] as const) {
      const root = await temporaryRoot();
      const extractor = fakeExtractor();
      const module = await createEpisodicMemoryModule({ pragmaHome: root, extractor });
      const short = [
        messageEvidence("short", "short-user", "user", "hi", sensitivity),
        terminalEvidence(
          "short",
          `short-terminal-${sensitivity}`,
          "2026-08-01T00:00:01.000Z",
          sensitivity,
        ),
      ];
      await module.consume(short);
      await module.runBackgroundOnce?.();
      expect(extractor.extract).not.toHaveBeenCalled();
      expect(await module.store.list()).toEqual([]);
      const diagnostic = await module.store.inspect();
      expect(diagnostic.rejected).toBe(1);
      expect(
        diagnostic.rejectedByReason[sensitivity === "restricted" ? "sensitive" : "low-value"],
      ).toBe(1);
      module.close();
    }
  });

  it("rejects incompatible restricted visibility before invoking the model", async () => {
    const root = await temporaryRoot();
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({ pragmaHome: root, extractor });
    const evidence = executionEvidence("visibility-conflict").map((item, index) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...item,
        visibility: {
          mode: "restricted",
          principals: [ref("pragma.expert", index === 1 ? "expert-b" : "expert-a")],
        },
      }),
    );

    await module.consume(evidence);
    await module.runBackgroundOnce?.();

    expect(extractor.extract).not.toHaveBeenCalled();
    expect(await module.store.list()).toEqual([]);
    expect(await module.store.inspect()).toMatchObject({
      rejected: 1,
      rejectedByReason: { policy: 1 },
      needsAttention: 0,
    });
    module.close();
  });

  it("moves repeated invalid Evidence references to needs_attention without dropping the job", async () => {
    const root = await temporaryRoot();
    let clock = new Date("2026-08-01T06:00:03.000Z");
    const extractor = fakeExtractor("unknown-evidence-id");
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor,
      now: () => clock,
    });
    await module.consume(executionEvidence("execution-c"));
    await module.runBackgroundOnce?.();
    clock = new Date(clock.getTime() + 61_000);
    await module.runBackgroundOnce?.();
    clock = new Date(clock.getTime() + 5 * 60_000 + 1_000);
    await module.runBackgroundOnce?.();
    const diagnostic = await module.store.inspect();
    expect(diagnostic).toMatchObject({
      needsAttention: 1,
      lastErrorCode: "extractor_evidence_ref_invalid",
    });
    expect(diagnostic.evidenceRecords).toBeGreaterThan(0);
    expect(await module.store.list()).toEqual([]);

    const database = new DatabaseSync(
      join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot("pragma.memory.episodic"),
        "jobs.sqlite",
      ),
    );
    database
      .prepare("UPDATE jobs SET job_json = ? WHERE status = 'needs_attention'")
      .run("{invalid-json");
    database.close();

    await expect(module.store.inspect()).resolves.toMatchObject({
      needsAttention: 1,
      lastErrorCode: "episodic_extraction_job_invalid",
    });
    await expect(module.store.wakeNeedsAttention(clock)).resolves.toBeUndefined();
    await expect(module.store.inspect()).resolves.toMatchObject({
      needsAttention: 1,
      lastErrorCode: "episodic_extraction_job_invalid",
    });
    module.close();
  });

  it("reads legacy Evidence attribution conservatively and rejects conflicting roots", async () => {
    const legacyRoot = await temporaryRoot();
    const legacy = await createEpisodicMemoryModule({
      pragmaHome: legacyRoot,
      extractor: fakeExtractor(),
    });
    const withoutAttribution = executionEvidence("legacy-attribution").map((item) =>
      MemoryEvidenceEnvelopeSchema.parse({ ...item, attribution: undefined }),
    );
    await legacy.consume(withoutAttribution);
    await legacy.runBackgroundOnce?.();
    expect((await legacy.store.list())[0]).toMatchObject({
      rootRefs: [{ type: "pragma.expert", id: "expert-a" }],
      bindings: [
        {
          consumerRef: { type: "pragma.expert", id: "expert-a" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
    });

    const legacyTeam = executionEvidence(
      "legacy-team-attribution",
      ref("pragma.expert-team", "team-a"),
      [ref("pragma.expert", "expert-a")],
    ).map((item) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...item,
        attribution: undefined,
        bindings: [...item.bindings].reverse(),
      }),
    );
    await legacy.consume(legacyTeam);
    await legacy.runBackgroundOnce?.();
    expect(
      (await legacy.store.list()).find(
        (episode) => episode.executionId === "legacy-team-attribution",
      ),
    ).toMatchObject({
      rootRefs: [{ type: "pragma.expert-team", id: "team-a" }],
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
    });
    legacy.close();

    const conflictRoot = await temporaryRoot();
    let clock = new Date("2026-08-01T06:00:03.000Z");
    const conflict = await createEpisodicMemoryModule({
      pragmaHome: conflictRoot,
      extractor: fakeExtractor(),
      now: () => clock,
    });
    const mismatched = executionEvidence("conflicting-attribution");
    mismatched[mismatched.length - 1] = terminalEvidence(
      "conflicting-attribution",
      "conflicting-attribution-terminal",
      "2026-08-01T00:00:02.000Z",
      "confidential",
      ref("pragma.flow", "foreign-flow"),
      [ref("pragma.expert", "expert-a")],
    );
    await conflict.consume(mismatched);
    for (const advance of [0, 61_000, 5 * 60_000 + 1_000]) {
      clock = new Date(clock.getTime() + advance);
      await conflict.runBackgroundOnce?.();
    }
    expect(await conflict.store.list()).toEqual([]);
    expect((await conflict.store.inspect()).needsAttention).toBe(1);
    conflict.close();
  });

  it("expires failed payloads after 30 days without startup-style retry", async () => {
    const module = await createEpisodicMemoryModule({ pragmaHome: await temporaryRoot() });
    const conversationRef = ref("pragma.mission", "mission-expiry");
    for (const executionId of ["expiry-a", "expiry-b"]) {
      await module.consume(
        executionEvidence(executionId).map((item) =>
          MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
        ),
      );
    }
    const job = await module.store.claimDueJob(new Date("2026-08-01T06:00:03.000Z"));
    expect(job).toBeDefined();
    await module.store.fail({
      job: job!,
      diagnostic: failureDiagnostic("memory_extractor_profile_invalid"),
      now: new Date("2026-08-01T00:00:04.000Z"),
      retry: "configuration",
    });

    await module.store.maintain(new Date("2026-09-01T00:00:05.000Z"));
    const [expired] = await module.store.listExtractionJobs();
    expect(expired).toMatchObject({ status: "expired", failureClass: "configuration" });
    await expect(module.store.readEvidence("expiry-a")).resolves.toEqual([]);
    await expect(module.store.readEvidence("expiry-b")).resolves.toEqual([]);
    await expect(
      module.store.retryJob({
        id: expired!.id,
        expectedRevision: expired!.revision,
        now: new Date(),
      }),
    ).rejects.toThrow("memory_extraction_job_not_retryable");
    module.close();
  });

  it("does not recreate transient state or long-term memory after an Execution is deleted", async () => {
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(),
    });
    const evidence = executionEvidence("deleted-execution");
    await module.consume(evidence);
    const claimed = await module.store.claimDueJob(new Date("2026-08-04T00:00:00.000Z"));
    expect(claimed).toBeDefined();
    await module.store.deleteExecutionState(["deleted-execution"]);
    await module.store.fail({
      job: claimed!,
      diagnostic: failureDiagnostic("late_extractor_failure"),
      now: new Date("2026-08-04T00:01:00.000Z"),
      retry: "transient",
    });

    await module.runBackgroundOnce?.();
    await module.consume(evidence);
    await module.runBackgroundOnce?.();

    expect(await module.store.readEvidence("deleted-execution")).toEqual([]);
    expect(await module.store.listExtractionJobs()).toEqual([]);
    expect(await module.store.list()).toEqual([]);
    module.close();
  });

  it("upgrades persisted extraction jobs from v1 through v3 on first access", async () => {
    const root = await temporaryRoot();
    const stateRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(
      "pragma.memory.episodic",
    );
    await mkdir(stateRoot, { recursive: true });
    const database = new DatabaseSync(join(stateRoot, "jobs.sqlite"));
    database.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        terminal_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_at TEXT,
        lease_until TEXT,
        job_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const legacyJob = {
      schemaVersion: "pragma.memory-extraction-job/v1",
      id: "legacy-job",
      executionId: "legacy-execution",
      terminalMessageId: "legacy-terminal",
      status: "needs_attention",
      attempts: 3,
      lastErrorCode: "legacy_failure",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    database
      .prepare(
        `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        legacyJob.id,
        legacyJob.executionId,
        legacyJob.terminalMessageId,
        legacyJob.status,
        JSON.stringify(legacyJob),
      );
    database.close();

    const module = await createEpisodicMemoryModule({ pragmaHome: root });
    await expect(module.store.listExtractionJobs()).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: "pragma.memory-extraction-job/v4",
        id: "legacy-job",
        revision: 2,
        totalAttempts: 3,
        status: "needs_attention",
        failureClass: "transient-exhausted",
      }),
    ]);
    const backup = new DatabaseSync(join(stateRoot, "jobs.sqlite.v1.backup"));
    expect(
      (backup.prepare("PRAGMA user_version").get() as unknown as { readonly user_version: number })
        .user_version,
    ).toBe(1);
    backup.close();
    module.close();

    const future = new DatabaseSync(join(stateRoot, "jobs.sqlite"));
    future.exec("PRAGMA user_version = 5;");
    future.close();
    await expect(createEpisodicMemoryModule({ pragmaHome: root })).rejects.toThrow(
      "unsupported-state-version:pragma.memory-episodic-jobs/v5",
    );
  });

  it("fails closed when an unversioned episodic database already contains tables", async () => {
    const root = await temporaryRoot();
    const stateRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(
      "pragma.memory.episodic",
    );
    await mkdir(stateRoot, { recursive: true });
    const database = new DatabaseSync(join(stateRoot, "jobs.sqlite"));
    database.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY);");
    database.close();

    await expect(createEpisodicMemoryModule({ pragmaHome: root })).rejects.toThrow(
      "corrupt-state-version:pragma.memory-episodic-jobs/v0-with-table:jobs",
    );
  });

  it("preserves v1 state and replays the migration after a malformed job is repaired", async () => {
    const root = await temporaryRoot();
    const stateRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(
      "pragma.memory.episodic",
    );
    await mkdir(stateRoot, { recursive: true });
    const statePath = join(stateRoot, "jobs.sqlite");
    const database = new DatabaseSync(statePath);
    database.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        terminal_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_at TEXT,
        lease_until TEXT,
        job_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const malformed = {
      schemaVersion: "pragma.memory-extraction-job/v1",
      id: "repairable-job",
      executionId: "repairable-execution",
      terminalMessageId: "repairable-terminal",
      status: "pending",
      attempts: 0,
    };
    database
      .prepare(
        `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        malformed.id,
        malformed.executionId,
        malformed.terminalMessageId,
        malformed.status,
        JSON.stringify(malformed),
      );
    database.close();

    await expect(createEpisodicMemoryModule({ pragmaHome: root })).rejects.toThrow();
    const preserved = new DatabaseSync(statePath);
    expect(
      (
        preserved.prepare("PRAGMA user_version").get() as unknown as {
          readonly user_version: number;
        }
      ).user_version,
    ).toBe(1);
    preserved
      .prepare("UPDATE jobs SET job_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...malformed, updatedAt: "2026-08-01T00:00:00.000Z" }), malformed.id);
    preserved.close();

    const recovered = await createEpisodicMemoryModule({ pragmaHome: root });
    expect((await recovered.store.listExtractionJobs())[0]).toMatchObject({
      schemaVersion: "pragma.memory-extraction-job/v4",
      id: malformed.id,
    });
    recovered.close();
  });
});

function fakeExtractor(
  forcedRef?: string,
  valueScore = 0.9,
  goalText = "完成记忆架构实现",
): EpisodicMemoryExtractor & { extract: ReturnType<typeof vi.fn> } {
  const extract = vi.fn(async (input: EpisodicExtractionInput) => {
    const ref = forcedRef ?? input.evidence.at(-1)!.messageId;
    return {
      output: {
        retain: true as const,
        language: "zh-Hans",
        goal: { text: goalText, evidenceRefs: [ref] },
        summary: { text: `实现并验证了分层记忆 ${input.executionId}。`, evidenceRefs: [ref] },
        attempts: [{ description: "实现 Episodic 模块", result: "成功", evidenceRefs: [ref] }],
        failuresAndRecoveries: [],
        outcome: { status: "succeeded" as const, summary: "实现完成", evidenceRefs: [ref] },
        valueScore,
      },
      provenance: {
        curatorRef: MEMORY_CURATOR_REF,
        promptVersion: "pragma.memory-curator/v1",
        profileRevision: 0,
        runtimeId: "test-runtime",
        providerId: "test-provider",
        modelId: "test-model",
        extractedAt: "2026-08-01T00:00:02.000Z",
      },
    };
  });
  return { extract };
}

function executionEvidence(
  executionId: string,
  rootRef: MemorySubjectRef = ref("pragma.expert", "expert-a"),
  producerRefs: readonly MemorySubjectRef[] = [ref("pragma.expert", "expert-a")],
): MemoryEvidenceEnvelope[] {
  return [
    messageEvidence(
      executionId,
      `${executionId}-user`,
      "user",
      "请实现分层 Episodic Memory，并完成消息总线、持久任务与测试。",
      "confidential",
      rootRef,
      producerRefs,
    ),
    messageEvidence(
      executionId,
      `${executionId}-assistant`,
      "assistant",
      "已经完成分层协议、Episodic Store、后台任务和 Context 投影。",
      "confidential",
      rootRef,
      producerRefs,
    ),
    terminalEvidence(
      executionId,
      `${executionId}-terminal`,
      "2026-08-01T00:00:02.000Z",
      "confidential",
      rootRef,
      producerRefs,
    ),
  ];
}

function messageEvidence(
  executionId: string,
  messageId: string,
  role: "user" | "assistant",
  text: string,
  sensitivity: "confidential" | "restricted" = "confidential",
  rootRef: MemorySubjectRef = ref("pragma.expert", "expert-a"),
  producerRefs: readonly MemorySubjectRef[] = [ref("pragma.expert", "expert-a")],
): MemoryEvidenceEnvelope {
  return envelope({
    executionId,
    messageId,
    topic: "execution.message.appended",
    schemaRef: "pragma.memory.execution-message/v2",
    sensitivity,
    payload: {
      message: role === "user" ? { role, text } : { role, text, stopReason: "stop" },
    },
    rootRef,
    producerRefs,
  });
}

function terminalEvidence(
  executionId: string,
  messageId: string,
  occurredAt: string,
  sensitivity: "confidential" | "restricted" = "confidential",
  rootRef: MemorySubjectRef = ref("pragma.expert", "expert-a"),
  producerRefs: readonly MemorySubjectRef[] = [ref("pragma.expert", "expert-a")],
): MemoryEvidenceEnvelope {
  return envelope({
    executionId,
    messageId,
    topic: "execution.execution.terminal",
    schemaRef: "pragma.memory.execution-terminal/v2",
    sensitivity,
    payload: { outcome: "succeeded" },
    occurredAt,
    rootRef,
    producerRefs,
  });
}

function envelope(input: {
  readonly executionId: string;
  readonly messageId: string;
  readonly topic: string;
  readonly schemaRef: string;
  readonly sensitivity: "confidential" | "restricted";
  readonly payload: unknown;
  readonly occurredAt?: string;
  readonly rootRef: MemorySubjectRef;
  readonly producerRefs: readonly MemorySubjectRef[];
}): MemoryEvidenceEnvelope {
  const consumers = uniqueRefs([input.rootRef, ...input.producerRefs]);
  return MemoryEvidenceEnvelopeSchema.parse({
    schemaVersion: "pragma.memory-evidence/v1",
    messageId: input.messageId,
    topic: input.topic,
    schemaRef: input.schemaRef,
    sourceRef: {
      type: "pragma.execution-event",
      id: input.messageId,
      canonicalEventId: `canonical-${input.messageId}`,
    },
    subjectRefs: [
      { type: "pragma.execution", id: input.executionId },
      input.rootRef,
      ...input.producerRefs,
    ],
    correlationId: input.executionId,
    occurredAt: input.occurredAt ?? "2026-08-01T00:00:00.000Z",
    visibility: { mode: "host-private" },
    sensitivity: input.sensitivity,
    bindings: consumers.map((consumerRef) => ({ consumerRef, access: "allow" })),
    attribution: { rootRef: input.rootRef, producerRefs: input.producerRefs },
    policySnapshot: {
      capture: true,
      recall: true,
      learning: "disabled",
      appliedRevisions: [],
    },
    payload: input.payload,
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-episodic-"));
  roots.push(root);
  return root;
}

function expertScope(id: string) {
  return {
    rootRef: { type: "pragma.expert" as const, id },
    expertRef: { type: "pragma.expert" as const, id },
  };
}

function scopedContext(registry: MemoryModuleRegistry, scope: MemoryRecallScope) {
  return createFederatedMemoryContextStore(registry, { resolveRecallScope: () => scope });
}

function ref<TType extends string>(
  type: TType,
  id: string,
): { readonly type: TType; readonly id: string } {
  return { type, id };
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((item) => [`${item.type}\0${item.id}`, item])).values()];
}

function simulateJobCompletionCrash(pragmaHome: string): void {
  const path = join(
    new PragmaPaths({ pragmaHome }).memoryModuleStateRoot("pragma.memory.episodic"),
    "jobs.sqlite",
  );
  const database = new DatabaseSync(path);
  database
    .prepare(
      "UPDATE jobs SET status = 'running', lease_until = '1970-01-01T00:00:00.000Z' WHERE status = 'completed'",
    )
    .run();
  database.close();
}
