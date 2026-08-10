import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

import {
  MemoryModuleRegistry,
  MEMORY_CURATOR_REF,
  SemanticExtractionOutputSchema,
  createFederatedMemoryContextStore,
  createSemanticMemoryModule,
  type MemoryRecallScope,
  type SemanticExtractionInput,
  type SemanticMemoryExtractor,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Semantic Memory", () => {
  it("extracts evidence-traceable facts into the layered Context without Episodic Memory", async () => {
    const extractor = fakeExtractor();
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
    });
    await module.registerExecutionSubjects({
      executionId: "execution-a",
      subjectRefs: [ref("pragma.user", "local-user"), ref("pragma.project", "project-a")],
    });
    const evidence = executionEvidence("execution-a", "Use concise Chinese answers.");

    await module.consume(evidence);
    await module.runBackgroundOnce?.();

    const facts = await module.store.list();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      statement: "The user prefers concise Chinese answers.",
      subjectRefs: [{ type: "pragma.user", id: "local-user" }],
      predicate: "user.preference.response-language",
      normalizedValue: "zh-Hans:concise",
      bindings: [{ consumerRef: { type: "pragma.expert", id: "expert-a" }, export: "deny" }],
    });

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = scopedContext(registry, expertScope("expert-a"));
    const listed = await context.listContext({});
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual([
      "guide.md",
      "overview.md",
      "semantic/index.md",
      "semantic/summary.md",
    ]);
    const detail = await context.readContext({ id: `semantic/items/${facts[0]!.id}.md` });
    expect(detail.ok && detail.value.content).toContain(
      "The user prefers concise Chinese answers.",
    );
    expect(detail.ok && detail.value.content).toContain("(semantic/evidence/");
    const evidenceDetail = await context.readContext({
      id: `semantic/evidence/${evidence[0]!.messageId}.md`,
    });
    expect(evidenceDetail.ok && evidenceDetail.value.content).toContain("Safe payload");
    const search = await context.searchContext({ query: evidence[0]!.messageId });
    expect(search.ok && search.value.some((item) => item.id.includes("/evidence/"))).toBe(false);
    module.close();
  });

  it("escapes fact statements used as Markdown link labels", async () => {
    const statement = "Click](https://example.com)[Fact";
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(() => ({ statement })),
    });
    await module.registerExecutionSubjects({
      executionId: "markdown-link-label",
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    await module.consume(executionEvidence("markdown-link-label", "Remember this fact."));
    await module.runBackgroundOnce?.();

    const [fact] = await module.store.list();
    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = scopedContext(registry, expertScope("expert-a"));
    const expectedLink = `[Click\\](https://example.com)\\[Fact](semantic/items/${fact!.id}.md)`;
    for (const id of ["semantic/summary.md", "semantic/index.md"]) {
      const item = await context.readContext({ id });
      expect(item.ok && item.value.content).toContain(expectedLink);
    }
    module.close();
  });

  it("merges equivalent observations and preserves exclusive conflicts symmetrically", async () => {
    const now = new Date("2026-08-03T18:00:01.000Z");
    const extractor = fakeExtractor((input) => {
      const text = evidenceText(input);
      return text.includes("light")
        ? { statement: "The theme is light.", normalizedValue: "light" }
        : { statement: "The theme is dark.", normalizedValue: "dark" };
    });
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
      now: () => now,
    });
    for (const [executionId, text] of [
      ["execution-dark-1", "The theme is dark."],
      ["execution-dark-2", "The theme is dark."],
      ["execution-light", "The theme is light."],
    ] as const) {
      await module.registerExecutionSubjects({
        executionId,
        subjectRefs: [ref("pragma.user", "local-user")],
      });
      await module.consume(executionEvidence(executionId, text));
      await module.runBackgroundOnce?.();
    }

    const facts = await module.store.list();
    expect(facts).toHaveLength(2);
    const dark = facts.find((fact) => fact.normalizedValue === "dark")!;
    const light = facts.find((fact) => fact.normalizedValue === "light")!;
    expect(dark.evidenceRefs.length).toBeGreaterThan(1);
    expect(dark.conflictsWith).toEqual([light.id]);
    expect(light.conflictsWith).toEqual([dark.id]);
    expect(dark.status).toBe("active");
    expect(light.status).toBe("active");
    expect(dark.updatedAt).toBe(now.toISOString());
    expect(light.updatedAt).toBe(now.toISOString());
    let pendingConflictNotifications = 0;
    for (;;) {
      const notification = await module.store.readProjectionNotification();
      if (notification === undefined) break;
      pendingConflictNotifications += 1;
      await module.store.acknowledgeProjectionNotification(notification.id);
    }
    expect(pendingConflictNotifications).toBe(2);
    expect(
      (await module.store.listExtractionJobs()).every(
        (job) => job.completedAt === now.toISOString(),
      ),
    ).toBe(true);
    module.close();
  });

  it("revises an exclusive fact in place when direct user Evidence authoritatively changes it", async () => {
    const onProjectionChanged = vi.fn(async () => undefined);
    const extractor = fakeExtractor((input) => {
      const previous = input.currentFacts[0];
      return evidenceText(input).includes("name is b")
        ? {
            statement: "The user's name is b.",
            normalizedValue: "b",
            predicate: "user.identity.name",
            ...(previous === undefined
              ? {}
              : {
                  replacementTarget: {
                    factId: previous.id,
                    expectedRevision: previous.revision,
                  },
                }),
          }
        : {
            statement: "The user's name is a.",
            normalizedValue: "a",
            predicate: "user.identity.name",
          };
    });
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
      onProjectionChanged,
    });
    for (const [executionId, text] of [
      ["name-a", "My name is a."],
      ["name-b", "My name is b."],
    ] as const) {
      await module.registerExecutionSubjects({
        executionId,
        subjectRefs: [ref("pragma.user", "local-user")],
      });
      await module.consume(executionEvidence(executionId, text));
      await module.runBackgroundOnce?.();
    }

    const [fact] = await module.store.list();
    expect(await module.store.list()).toHaveLength(1);
    expect(fact).toMatchObject({ revision: 2, normalizedValue: "b", conflictsWith: [] });
    expect((await module.store.history(fact!.id)).map((item) => item.normalizedValue)).toEqual([
      "b",
      "a",
    ]);
    expect(onProjectionChanged).toHaveBeenCalledTimes(2);
    module.close();
  });

  it("omits low-score facts from index while retaining deep search recall", async () => {
    const now = new Date("2028-08-03T18:00:01.000Z");
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      now: () => now,
      extractor: fakeExtractor(() => ({
        statement: "The user's archived marker is cobalt-archive.",
        normalizedValue: "cobalt-archive",
        confidence: 0.1,
      })),
    });
    await module.registerExecutionSubjects({
      executionId: "archived-fact",
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    await module.consume(executionEvidence("archived-fact", "Remember cobalt-archive."));
    await module.runBackgroundOnce?.();

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = scopedContext(registry, expertScope("expert-a"));
    const index = await context.readContext({ id: "semantic/index.md" });
    expect(index.ok && index.value.content).not.toContain("cobalt-archive");
    const search = await context.searchContext({ query: "cobalt-archive" });
    expect(search.ok && search.value.some((item) => item.id.includes("semantic/items/"))).toBe(
      true,
    );
    module.close();
  });

  it("finishes an applied job after a crash without invoking the Curator twice", async () => {
    const root = await temporaryRoot();
    const extractor = fakeExtractor();
    const module = await createSemanticMemoryModule({ pragmaHome: root, extractor });
    await module.registerExecutionSubjects({
      executionId: "execution-crash",
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    await module.consume(executionEvidence("execution-crash", "Use concise Chinese answers."));
    await module.runBackgroundOnce?.();
    simulateJobCompletionCrash(root);

    await module.runBackgroundOnce?.();

    expect(extractor.extract).toHaveBeenCalledOnce();
    expect((await module.store.inspect()).running).toBe(0);
    expect(await module.store.list()).toHaveLength(1);
    module.close();
  });

  it("applies later watermarks for the same Mission instead of treating the conversation as already applied", async () => {
    let clock = new Date("2026-08-03T16:00:02.000Z");
    const extractor = fakeExtractor();
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
      now: () => clock,
    });
    const conversationRef = ref("pragma.mission", "mission-semantic-revision");
    for (const executionId of ["semantic-turn-1", "semantic-turn-2"]) {
      await module.registerExecutionSubjects({
        executionId,
        subjectRefs: [ref("pragma.user", "local-user")],
      });
      await module.consume(
        executionEvidence(executionId, "Use concise Chinese answers.").map((item) =>
          MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
        ),
      );
      await module.runBackgroundOnce?.();
      clock = new Date(clock.getTime() + 1_000);
    }
    expect(extractor.extract).toHaveBeenCalledTimes(2);
    const facts = await module.store.list();
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ revision: 2 });
    expect((await module.store.listExtractionJobs())[0]).toMatchObject({
      status: "completed",
      sourceExecutionIds: ["semantic-turn-1", "semantic-turn-2"],
    });
    module.close();
  });

  it("merges an execution-scoped fallback job when the Mission binding arrives", async () => {
    const module = await createSemanticMemoryModule({ pragmaHome: await temporaryRoot() });
    const conversationRef = ref("pragma.mission", "mission-semantic-late-binding");
    await module.consume(
      executionEvidence("semantic-bound", "Use concise Chinese answers.").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    await module.consume(executionEvidence("semantic-fallback", "Use concise Chinese answers."));
    expect(await module.store.listExtractionJobs()).toHaveLength(2);

    await module.bindExecutionConversation({
      executionId: "semantic-fallback",
      conversationRef,
      now: new Date("2026-08-03T10:01:00.000Z"),
    });

    await expect(module.store.listExtractionJobs()).resolves.toEqual([
      expect.objectContaining({
        conversationRef,
        sourceExecutionIds: ["semantic-bound", "semantic-fallback"],
      }),
    ]);
    module.close();
  });

  it("expedites, interrupts, and deletes semantic input and subject context", async () => {
    const module = await createSemanticMemoryModule({ pragmaHome: await temporaryRoot() });
    const now = new Date("2026-08-05T08:00:00.000Z");
    const executionId = "semantic-managed";
    const conversationRef = ref("pragma.mission", "mission-semantic-managed");
    await module.registerExecutionSubjects({
      executionId,
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    await module.consume(
      executionEvidence(executionId, "Remember this preference.").map((item) =>
        MemoryEvidenceEnvelopeSchema.parse({ ...item, conversationRef }),
      ),
    );
    const [waiting] = await module.store.listExtractionJobs();
    await module.store.expediteJob({ id: waiting!.id, expectedRevision: waiting!.revision, now });
    const claimed = await module.store.claimDueJob(now);
    const interrupted = await module.store.interruptJob({
      id: claimed!.id,
      expectedRevision: claimed!.revision,
      now,
    });
    expect(interrupted).toMatchObject({
      status: "waiting_idle",
      eligibleAt: "2026-08-05T14:00:00.000Z",
    });
    await module.store.expediteJob({
      id: interrupted.id,
      expectedRevision: interrupted.revision,
      now,
    });
    const reclaimed = await module.store.claimDueJob(now);
    await module.store.fail({
      job: reclaimed!,
      errorCode: "memory_extractor_profile_invalid",
      retry: "configuration",
      now,
    });
    const [attention] = await module.store.listExtractionJobs();
    await module.store.deleteJob({
      id: attention!.id,
      expectedRevision: attention!.revision,
      now,
    });
    expect(await module.store.listExtractionJobs()).toEqual([]);
    expect(await module.store.getSubjectContext(executionId)).toBeUndefined();
    expect(await module.store.readEvidence(executionId)).toEqual([]);
    module.close();
  });

  it("isolates bindings across Experts and excludes expired facts from recall", async () => {
    const now = new Date("2026-08-03T18:00:01.000Z");
    const extractor = fakeExtractor((input) => ({
      statement: `Fact for ${input.executionId}`,
      normalizedValue: input.executionId,
      ...(input.executionId === "execution-a" ? { expiresAt: "2026-08-03T11:00:00.000Z" } : {}),
    }));
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
      now: () => now,
    });
    for (const [executionId, expertId] of [
      ["execution-a", "expert-a"],
      ["execution-b", "expert-b"],
    ] as const) {
      await module.registerExecutionSubjects({
        executionId,
        subjectRefs: [ref("pragma.user", "local-user")],
      });
      await module.consume(executionEvidence(executionId, `Fact for ${expertId}`, expertId));
      await module.runBackgroundOnce?.();
    }
    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const contextA = scopedContext(registry, expertScope("expert-a"));
    const indexA = await contextA.readContext({ id: "semantic/index.md" });
    expect(indexA.ok && indexA.value.content).not.toContain("execution-a");
    expect(indexA.ok && indexA.value.content).not.toContain("execution-b");
    const contextB = scopedContext(registry, expertScope("expert-b"));
    const indexB = await contextB.readContext({ id: "semantic/index.md" });
    expect(indexB.ok && indexB.value.content).toContain("execution-b");
    module.close();
  });

  it("combines a Team binding with the current Expert personal facts without exposing peers", async () => {
    const extractor = fakeExtractor((input) => ({
      statement: `Fact for ${input.executionId}`,
      normalizedValue: input.executionId,
    }));
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
    });
    const cases = [
      {
        executionId: "personal-a",
        rootRef: ref("pragma.expert", "expert-a"),
        producerRef: ref("pragma.expert", "expert-a"),
      },
      {
        executionId: "personal-b",
        rootRef: ref("pragma.expert", "expert-b"),
        producerRef: ref("pragma.expert", "expert-b"),
      },
      {
        executionId: "team-a",
        rootRef: ref("pragma.expert-team", "team-a"),
        producerRef: ref("pragma.expert", "expert-a"),
      },
    ];
    for (const item of cases) {
      await module.registerExecutionSubjects({
        executionId: item.executionId,
        subjectRefs: [ref("pragma.user", "local-user")],
      });
      await module.consume(
        executionEvidenceForRoot(
          item.executionId,
          `Fact for ${item.executionId}`,
          item.rootRef,
          item.producerRef,
        ),
      );
      await module.runBackgroundOnce?.();
    }

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const team = scopedContext(registry, {
      rootRef: { type: "pragma.expert-team", id: "team-a" },
      expertRef: { type: "pragma.expert", id: "expert-a" },
    });
    const index = await team.readContext({ id: "semantic/index.md" });
    expect(index.ok && index.value.content).toMatch(
      /team-a[\s\S]*personal-a|personal-a[\s\S]*team-a/,
    );
    expect(index.ok && index.value.content).not.toContain("personal-b");
    const teamOnly = scopedContext(registry, {
      rootRef: { type: "pragma.expert-team", id: "team-a" },
    });
    const teamOnlyIndex = await teamOnly.readContext({ id: "semantic/index.md" });
    expect(teamOnlyIndex.ok && teamOnlyIndex.value.content).toContain("team-a");
    expect(teamOnlyIndex.ok && teamOnlyIndex.value.content).not.toMatch(/personal-a|personal-b/);
    const foreign = (await module.store.list()).find(
      (fact) => fact.normalizedValue === "personal-b",
    )!;
    await expect(
      team.readContext({ id: `semantic/items/${foreign.id}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    module.close();
  });

  it("keeps immutable revision history for correction, verification, and invalidation", async () => {
    const onProjectionChanged = vi.fn(async () => undefined);
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(),
      onProjectionChanged,
    });
    await module.registerExecutionSubjects({
      executionId: "execution-governance",
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    await module.consume(executionEvidence("execution-governance", "Use concise Chinese answers."));
    await module.runBackgroundOnce?.();
    const initial = (await module.store.list())[0]!;
    const actorRef = ref("pragma.user", "local-user");
    const revised = await module.store.revise({
      id: initial.id,
      expectedRevision: initial.revision,
      actorRef,
      reason: "User corrected the preference.",
      patch: {
        statement: "The user prefers detailed Chinese answers.",
        normalizedValue: "zh-Hans:detailed",
      },
      now: new Date("2026-08-03T13:00:00.000Z"),
    });
    await module.runBackgroundOnce?.();
    await expect(
      module.store.verify({
        id: initial.id,
        expectedRevision: initial.revision,
        actorRef,
        reason: "Stale revision",
        now: new Date("2026-08-03T13:01:00.000Z"),
      }),
    ).rejects.toThrow("semantic_fact_revision_conflict");
    const verified = await module.store.verify({
      id: revised.id,
      expectedRevision: revised.revision,
      actorRef,
      reason: "The user explicitly confirmed this preference.",
      now: new Date("2026-08-03T13:01:00.000Z"),
    });
    await module.runBackgroundOnce?.();
    expect(verified.confidence).toBe(1);
    const invalidated = await module.store.invalidate({
      id: verified.id,
      expectedRevision: verified.revision,
      actorRef,
      reason: "The preference is no longer valid.",
      now: new Date("2026-08-03T13:02:00.000Z"),
    });
    await module.runBackgroundOnce?.();
    expect(invalidated.status).toBe("invalidated");
    const history = await module.store.history(initial.id);
    expect(history.map((revision) => revision.revision)).toEqual([4, 3, 2, 1]);
    expect(history.at(-1)?.statement).toBe("The user prefers concise Chinese answers.");
    expect(onProjectionChanged).toHaveBeenCalledTimes(3);
    module.close();
  });

  it("backs off failed projection notifications without dropping or misclassifying them", async () => {
    let now = new Date("2026-08-03T18:00:01.000Z");
    const onProjectionChanged = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("knowledge_sink_unavailable"))
      .mockResolvedValue(undefined);
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(),
      onProjectionChanged,
      now: () => now,
    });
    await module.registerExecutionSubjects({
      executionId: "execution-notification-retry",
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    await module.consume(
      executionEvidence("execution-notification-retry", "Use concise Chinese answers."),
    );

    await expect(module.runBackgroundOnce?.()).rejects.toThrow("knowledge_sink_unavailable");
    expect(onProjectionChanged).toHaveBeenCalledTimes(1);
    expect(await module.store.listExtractionJobs()).toMatchObject([{ status: "completed" }]);
    expect(await module.store.readProjectionNotification()).toBeDefined();

    await expect(module.runBackgroundOnce?.()).rejects.toThrow("knowledge_sink_unavailable");
    expect(onProjectionChanged).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 2_000);
    await module.runBackgroundOnce?.();
    expect(onProjectionChanged).toHaveBeenCalledTimes(2);
    expect(await module.store.readProjectionNotification()).toBeUndefined();
    module.close();
  });

  it("enforces restricted principals and purges forgotten fact content and Evidence", async () => {
    const root = await temporaryRoot();
    const onProjectionChanged = vi.fn(async () => undefined);
    const module = await createSemanticMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
      onProjectionChanged,
    });
    await module.registerExecutionSubjects({
      executionId: "execution-private-fact",
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    const evidence = executionEvidence(
      "execution-private-fact",
      "Use concise Chinese answers.",
    ).map((item) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...item,
        visibility: {
          mode: "restricted",
          principals: [ref("pragma.user", "local-user")],
        },
      }),
    );
    await module.consume(evidence);
    await module.runBackgroundOnce?.();
    const initial = (await module.store.list())[0]!;
    expect(await module.store.listForRecall(expertScope("expert-a"), new Date())).toEqual([]);
    const principalScope = {
      ...expertScope("expert-a"),
      principalRefs: [ref("pragma.user", "local-user")],
    };
    expect(await module.store.listForRecall(principalScope, new Date())).toHaveLength(1);

    const actorRef = ref("pragma.user", "local-user");
    const tightened = await module.store.tightenAccess({
      id: initial.id,
      expectedRevision: initial.revision,
      actorRef,
      reason: "Disable recall for this fact.",
      bindings: initial.bindings.map((binding) => ({
        ...binding,
        recall: "deny" as const,
        permissionRevision: binding.permissionRevision + 1,
      })),
      now: new Date("2026-08-03T13:00:00.000Z"),
    });
    await module.runBackgroundOnce?.();
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
        now: new Date("2026-08-03T13:01:00.000Z"),
      }),
    ).rejects.toThrow("memory_permission_expansion_denied");

    const dataPath = join(
      new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.semantic"),
      "facts.sqlite",
    );
    const cleanupFixtureAt = "2026-08-03T13:01:45.000Z";
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
      now: new Date("2026-08-03T13:02:00.000Z"),
    });
    await module.runBackgroundOnce?.();
    expect(await module.store.get(initial.id)).toBeUndefined();
    expect(await module.store.history(initial.id)).toEqual([]);
    expect(await module.store.getEvidence(evidence[0]!.messageId)).toBeUndefined();
    expect(onProjectionChanged).toHaveBeenCalledTimes(1);
    module.close();

    const database = new DatabaseSync(dataPath);
    const tombstone = database
      .prepare("SELECT tombstone_json AS value FROM tombstones WHERE id = ?")
      .get(initial.id) as { readonly value: string };
    const governance = database
      .prepare("SELECT COUNT(*) AS count FROM governance_events WHERE fact_id = ?")
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
      /concise Chinese|statement|normalizedValue|evidenceRefs|Disable recall|User requested forgetting/,
    );
  });

  it("reopens the current store version and rejects a future data version", async () => {
    const root = await temporaryRoot();
    const module = await createSemanticMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
    });
    module.close();

    const reopened = await createSemanticMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
    });
    reopened.close();

    const database = new DatabaseSync(
      join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.semantic"),
        "facts.sqlite",
      ),
    );
    database.exec("PRAGMA user_version = 6");
    database.close();

    await expect(
      createSemanticMemoryModule({ pragmaHome: root, extractor: fakeExtractor() }),
    ).rejects.toThrow("unsupported-state-version:pragma.memory-semantic-store/v6");
  });

  it("upgrades historical semantic jobs through the registered migration and keeps a backup", async () => {
    const root = await temporaryRoot();
    const stateRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(
      "pragma.memory.semantic",
    );
    await mkdir(stateRoot, { recursive: true });
    const statePath = join(stateRoot, "jobs.sqlite");
    const database = new DatabaseSync(statePath);
    database.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        terminal_message_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        retry_at TEXT,
        lease_until TEXT,
        job_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const legacy = {
      schemaVersion: "pragma.memory-semantic-job/v1",
      id: "legacy-semantic-job",
      executionId: "legacy-semantic-execution",
      terminalMessageId: "legacy-semantic-terminal",
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
        legacy.id,
        legacy.executionId,
        legacy.terminalMessageId,
        legacy.status,
        JSON.stringify(legacy),
      );
    database.close();

    const module = await createSemanticMemoryModule({ pragmaHome: root });
    await expect(module.store.listExtractionJobs()).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: "pragma.memory-semantic-job/v3",
        id: legacy.id,
        revision: 2,
        totalAttempts: 3,
        status: "needs_attention",
        failureClass: "transient-exhausted",
      }),
    ]);
    const backup = new DatabaseSync(`${statePath}.v1.backup`);
    expect(
      (backup.prepare("PRAGMA user_version").get() as unknown as { readonly user_version: number })
        .user_version,
    ).toBe(1);
    backup.close();
    module.close();
  });

  it("rejects extractor subject and Evidence references outside the supplied allowlists", async () => {
    const extractor = fakeExtractor(() => ({
      statement: "Untrusted fact.",
      normalizedValue: "untrusted",
      subjectRefs: [ref("pragma.repository", "invented")],
      evidenceRefs: ["invented-evidence"],
    }));
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
    });
    await module.registerExecutionSubjects({
      executionId: "execution-invalid",
      subjectRefs: [ref("pragma.user", "local-user")],
    });
    await module.consume(executionEvidence("execution-invalid", "Remember this stable fact."));
    await module.runBackgroundOnce?.();
    expect(await module.store.list()).toEqual([]);
    expect((await module.store.inspect()).running).toBe(0);
    expect(extractor.extract).toHaveBeenCalledOnce();
    module.close();
  });
});

function fakeExtractor(
  customize: (input: SemanticExtractionInput) => Partial<{
    statement: string;
    normalizedValue: string;
    predicate: string;
    confidence: number;
    replacementTarget: { readonly factId: string; readonly expectedRevision: number };
    subjectRefs: readonly MemorySubjectRef[];
    evidenceRefs: readonly string[];
    expiresAt: string;
  }> = () => ({}),
): SemanticMemoryExtractor & { extract: ReturnType<typeof vi.fn> } {
  const extract = vi.fn(async (input: SemanticExtractionInput) => {
    const custom = customize(input);
    const user = input.allowedSubjectRefs.find((item) => item.type === "pragma.user")!;
    const evidenceRef = input.evidence.find(
      (item) => item.schemaRef === "pragma.memory.execution-message/v2",
    )!.messageId;
    return {
      output: SemanticExtractionOutputSchema.parse({
        retain: true as const,
        facts: [
          {
            statement: "The user prefers concise Chinese answers.",
            subjectRefs: [user],
            predicate: "user.preference.response-language",
            normalizedValue: "zh-Hans:concise",
            conflictMode: "exclusive" as const,
            confidence: 0.8,
            evidenceRefs: [evidenceRef],
            ...custom,
          },
        ],
      }),
      provenance: {
        curatorRef: MEMORY_CURATOR_REF,
        promptVersion: "pragma.memory-curator.semantic/v1",
        profileRevision: 0,
        runtimeId: "runtime",
        providerId: "provider",
        modelId: "model",
        extractedAt: "2026-08-03T12:00:00.000Z",
      },
    };
  });
  return { extract };
}

function evidenceText(input: SemanticExtractionInput): string {
  return input.evidence
    .flatMap((item) => {
      const payload = item.payload as { readonly message?: { readonly text?: unknown } };
      return typeof payload.message?.text === "string" ? [payload.message.text] : [];
    })
    .join("\n");
}

function executionEvidence(
  executionId: string,
  text: string,
  expertId = "expert-a",
): readonly MemoryEvidenceEnvelope[] {
  const rootRef = ref("pragma.expert", expertId);
  return executionEvidenceForRoot(executionId, text, rootRef, rootRef);
}

function executionEvidenceForRoot(
  executionId: string,
  text: string,
  rootRef: MemorySubjectRef,
  producerRef: MemorySubjectRef,
): readonly MemoryEvidenceEnvelope[] {
  return [
    evidence(
      executionId,
      `${executionId}-message`,
      "execution.message.appended",
      text,
      rootRef,
      producerRef,
    ),
    evidence(
      executionId,
      `${executionId}-terminal`,
      "execution.execution.terminal",
      undefined,
      rootRef,
      producerRef,
    ),
  ];
}

function evidence(
  executionId: string,
  messageId: string,
  topic: "execution.message.appended" | "execution.execution.terminal",
  text: string | undefined,
  rootRef: MemorySubjectRef,
  producerRef: MemorySubjectRef,
): MemoryEvidenceEnvelope {
  return MemoryEvidenceEnvelopeSchema.parse({
    schemaVersion: "pragma.memory-evidence/v1",
    messageId,
    topic,
    schemaRef:
      topic === "execution.message.appended"
        ? "pragma.memory.execution-message/v2"
        : "pragma.memory.execution-terminal/v2",
    sourceRef: {
      type: "pragma.execution-event",
      id: messageId,
      canonicalEventId: `canonical-${messageId}`,
    },
    subjectRefs: [ref("pragma.execution", executionId), rootRef],
    correlationId: executionId,
    occurredAt:
      topic === "execution.message.appended"
        ? "2026-08-03T10:00:00.000Z"
        : "2026-08-03T10:00:01.000Z",
    visibility: { mode: "host-private" },
    sensitivity: "confidential",
    bindings: [{ consumerRef: rootRef, access: "allow" }],
    attribution: { rootRef, producerRefs: [producerRef] },
    policySnapshot: {
      capture: true,
      recall: true,
      learning: "local-candidates",
      appliedRevisions: [],
    },
    payload: text === undefined ? { outcome: "succeeded" } : { message: { role: "user", text } },
  });
}

function scopedContext(registry: MemoryModuleRegistry, scope: MemoryRecallScope) {
  return createFederatedMemoryContextStore(registry, { resolveRecallScope: () => scope });
}

function expertScope(id: string): MemoryRecallScope {
  return {
    rootRef: { type: "pragma.expert", id },
    expertRef: { type: "pragma.expert", id },
  };
}

function ref(type: string, id: string): MemorySubjectRef {
  return { type, id };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-semantic-"));
  roots.push(root);
  return root;
}

function simulateJobCompletionCrash(pragmaHome: string): void {
  const database = new DatabaseSync(
    join(
      new PragmaPaths({ pragmaHome }).memoryModuleStateRoot("pragma.memory.semantic"),
      "jobs.sqlite",
    ),
  );
  const row = database.prepare("SELECT id, job_json AS jobJson FROM jobs LIMIT 1").get() as {
    readonly id: string;
    readonly jobJson: string;
  };
  const job = JSON.parse(row.jobJson) as Record<string, unknown>;
  delete job["completion"];
  job["status"] = "running";
  job["leaseUntil"] = "2026-08-03T00:00:00.000Z";
  database
    .prepare("UPDATE jobs SET status = 'running', lease_until = ?, job_json = ? WHERE id = ?")
    .run(job["leaseUntil"] as string, JSON.stringify(job), row.id);
  database.close();
}
