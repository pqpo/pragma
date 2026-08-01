import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import { MemoryEvidenceEnvelopeSchema, type MemoryEvidenceEnvelope } from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEpisodicMemoryModule,
  createFederatedMemoryContextStore,
  MemoryModuleRegistry,
  type EpisodicExtractionInput,
  type EpisodicMemoryExtractor,
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
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({ pragmaHome: root, extractor });
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
    const readEvidence = vi.spyOn(module.store, "readEvidence");
    const getEvidence = vi.spyOn(module.store, "getEvidence");

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = createFederatedMemoryContextStore(registry);
    const listed = await context.listContext({});
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual([
      "catalog.md",
      "episodic/index.md",
      "episodic/summary.md",
      "guide.md",
      "overview.md",
    ]);
    const overview = await context.readContext({ id: "overview.md" });
    expect(overview.ok && overview.value.content).toContain("Episodic Memory Summary");
    const detail = await context.readContext({ id: `episodic/items/${episodes[0]!.id}.md` });
    expect(detail.ok && detail.value.content).toContain("## Evidence");
    expect(readEvidence).not.toHaveBeenCalled();
    expect(getEvidence).not.toHaveBeenCalled();
    const evidenceDetail = await context.readContext({
      id: `episodic/evidence/${evidence[0]!.messageId}.md`,
    });
    expect(evidenceDetail.ok && evidenceDetail.value.content).toContain("Safe payload");
    expect(getEvidence).toHaveBeenCalledOnce();
    const search = await context.searchContext({ query: evidence[0]!.messageId });
    expect(search.ok && search.value.some((match) => match.id.includes("/evidence/"))).toBe(false);
    module.close();
  });

  it("fails closed when recall is disabled for the current asset", async () => {
    const registry = new MemoryModuleRegistry();
    const module = await createEpisodicMemoryModule({ pragmaHome: await temporaryRoot() });
    registry.register(module);
    const context = createFederatedMemoryContextStore(registry, {
      canRecall: (runContext) => runContext?.source?.id !== "blocked-expert",
    });
    const runContext = { source: { type: "pragma.expert", id: "blocked-expert" } };

    await expect(context.listContext({ context: runContext })).resolves.toEqual({
      ok: true,
      value: [],
    });
    await expect(
      context.readContext({ id: "overview.md", context: runContext }),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
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
      expect((await module.store.inspect()).rejectedLowValue).toBe(1);
      module.close();
    }
  });

  it("moves repeated invalid Evidence references to needs_attention without dropping the job", async () => {
    const root = await temporaryRoot();
    let clock = new Date("2026-08-01T00:00:00.000Z");
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
    expect(diagnostic.needsAttention).toBe(1);
    expect(await module.store.list()).toEqual([]);
    module.close();
  });
});

function fakeExtractor(
  forcedRef?: string,
): EpisodicMemoryExtractor & { extract: ReturnType<typeof vi.fn> } {
  const extract = vi.fn(async (input: EpisodicExtractionInput) => {
    const ref = forcedRef ?? input.evidence.at(-1)!.messageId;
    return {
      output: {
        retain: true as const,
        language: "zh-Hans",
        goal: { text: "完成记忆架构实现", evidenceRefs: [ref] },
        summary: { text: "实现并验证了分层记忆。", evidenceRefs: [ref] },
        attempts: [{ description: "实现 Episodic 模块", result: "成功", evidenceRefs: [ref] }],
        failuresAndRecoveries: [],
        outcome: { status: "succeeded" as const, summary: "实现完成", evidenceRefs: [ref] },
        valueScore: 0.9,
      },
      provenance: {
        curatorRef: "expert:0000000000memory",
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

function executionEvidence(executionId: string): MemoryEvidenceEnvelope[] {
  return [
    messageEvidence(
      executionId,
      `${executionId}-user`,
      "user",
      "请实现分层 Episodic Memory，并完成消息总线、持久任务与测试。",
    ),
    messageEvidence(
      executionId,
      `${executionId}-assistant`,
      "assistant",
      "已经完成分层协议、Episodic Store、后台任务和 Context 投影。",
    ),
    terminalEvidence(executionId, `${executionId}-terminal`, "2026-08-01T00:00:02.000Z"),
  ];
}

function messageEvidence(
  executionId: string,
  messageId: string,
  role: "user" | "assistant",
  text: string,
  sensitivity: "confidential" | "restricted" = "confidential",
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
  });
}

function terminalEvidence(
  executionId: string,
  messageId: string,
  occurredAt: string,
  sensitivity: "confidential" | "restricted" = "confidential",
): MemoryEvidenceEnvelope {
  return envelope({
    executionId,
    messageId,
    topic: "execution.execution.terminal",
    schemaRef: "pragma.memory.execution-terminal/v2",
    sensitivity,
    payload: { outcome: "succeeded" },
    occurredAt,
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
}): MemoryEvidenceEnvelope {
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
      { type: "pragma.expert", id: "expert-a" },
    ],
    correlationId: input.executionId,
    occurredAt: input.occurredAt ?? "2026-08-01T00:00:00.000Z",
    visibility: { mode: "host-private" },
    sensitivity: input.sensitivity,
    bindings: [{ consumerRef: { type: "pragma.expert", id: "expert-a" }, access: "allow" }],
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
