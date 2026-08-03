import { mkdtemp, rm } from "node:fs/promises";
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
      "catalog.md",
      "guide.md",
      "overview.md",
      "semantic/index.md",
      "semantic/summary.md",
    ]);
    const detail = await context.readContext({ id: `semantic/items/${facts[0]!.id}.md` });
    expect(detail.ok && detail.value.content).toContain(
      "The user prefers concise Chinese answers.",
    );
    const evidenceDetail = await context.readContext({
      id: `semantic/evidence/${evidence[0]!.messageId}.md`,
    });
    expect(evidenceDetail.ok && evidenceDetail.value.content).toContain("Safe payload");
    const search = await context.searchContext({ query: evidence[0]!.messageId });
    expect(search.ok && search.value.some((item) => item.id.includes("/evidence/"))).toBe(false);
    module.close();
  });

  it("merges equivalent observations and preserves exclusive conflicts symmetrically", async () => {
    const extractor = fakeExtractor((input) => {
      const text = evidenceText(input);
      return text.includes("light")
        ? { statement: "The theme is light.", normalizedValue: "light" }
        : { statement: "The theme is dark.", normalizedValue: "dark" };
    });
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor,
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

  it("isolates bindings across Experts and excludes expired facts from recall", async () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
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
    const foreign = (await module.store.list()).find(
      (fact) => fact.normalizedValue === "personal-b",
    )!;
    await expect(
      team.readContext({ id: `semantic/items/${foreign.id}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    module.close();
  });

  it("keeps immutable revision history for correction, verification, and invalidation", async () => {
    const module = await createSemanticMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(),
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
    expect(verified.confidence).toBe(1);
    const invalidated = await module.store.invalidate({
      id: verified.id,
      expectedRevision: verified.revision,
      actorRef,
      reason: "The preference is no longer valid.",
      now: new Date("2026-08-03T13:02:00.000Z"),
    });
    expect(invalidated.status).toBe("invalidated");
    const history = await module.store.history(initial.id);
    expect(history.map((revision) => revision.revision)).toEqual([4, 3, 2, 1]);
    expect(history.at(-1)?.statement).toBe("The user prefers concise Chinese answers.");
    module.close();
  });

  it("enforces restricted principals and purges forgotten fact content and Evidence", async () => {
    const root = await temporaryRoot();
    const module = await createSemanticMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
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

    await module.store.forget({
      id: tightened.id,
      expectedRevision: tightened.revision,
      actorRef,
      reason: "User requested forgetting.",
      now: new Date("2026-08-03T13:02:00.000Z"),
    });
    expect(await module.store.get(initial.id)).toBeUndefined();
    expect(await module.store.history(initial.id)).toEqual([]);
    expect(await module.store.getEvidence(evidence[0]!.messageId)).toBeUndefined();
    module.close();

    const database = new DatabaseSync(
      join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.semantic"),
        "facts.sqlite",
      ),
    );
    const tombstone = database
      .prepare("SELECT tombstone_json AS value FROM tombstones WHERE id = ?")
      .get(initial.id) as { readonly value: string };
    const governance = database
      .prepare("SELECT COUNT(*) AS count FROM governance_events WHERE fact_id = ?")
      .get(initial.id) as { readonly count: number };
    database.close();
    expect(governance.count).toBe(0);
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
    database.exec("PRAGMA user_version = 3");
    database.close();

    await expect(
      createSemanticMemoryModule({ pragmaHome: root, extractor: fakeExtractor() }),
    ).rejects.toThrow("unsupported-state-version:pragma.memory-semantic-store/v3");
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
        curatorRef: "expert:0000000000memory",
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
