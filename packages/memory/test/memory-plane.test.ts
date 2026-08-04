import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createFileCanonicalEventFeed, createFileExecutionStore, PragmaPaths } from "@pragma/core";
import {
  CanonicalEventEnvelopeSchema,
  MemoryEvidenceEnvelopeSchema,
  type ExecutionRecord,
  type Invocation,
} from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  MemoryModuleRegistry,
  createExecutionEvidenceAdapter,
  createFileMemoryPolicyStore,
  createFederatedMemoryContextStore,
  createFileMemoryPipelineStateStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  type MemoryConsumerCheckpointStore,
  type MemoryDerivedEventOutboxStore,
  type MemoryEvidencePublisher,
} from "../src/index.ts";
import { createProbeMemoryModule } from "../src/testing/index.ts";

describe("Memory Plane phase one", () => {
  it("adapts canonical events, isolates modules, and exposes Probe through Context", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-plane-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    const executions = createFileExecutionStore({
      pragmaHome: home,
      canonicalEventFeed: canonical,
    });
    await createExecution(executions);
    await executions.appendEvent(
      "execution",
      "root",
      "invocation.message.appended",
      {
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            {
              type: "toolCall",
              id: "tool-one",
              name: "secret-tool",
              arguments: { token: "must-not-enter-memory" },
            },
            { type: "text", text: "hello memory", textSignature: "private-signature" },
          ],
          api: "test",
          provider: "test",
          model: "test",
          diagnostics: [{ private: true }],
          usage: {
            measurement: "reported",
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      },
      "message-one",
    );

    let currentTime = new Date("2026-08-01T00:00:00.000Z");
    const now = () => currentTime;
    const state = createFileMemoryPipelineStateStore({ pragmaHome: home, now });
    const policies = createFileMemoryPolicyStore({ pragmaHome: home, now });
    const publisher = createMemoryEvidencePublisher(canonical);
    const evidence = createMemoryEvidenceFeed(canonical);
    const adapter = createExecutionEvidenceAdapter({
      source: canonical,
      publisher,
      checkpoints: state,
      deadLetters: state,
      policies,
      now,
    });
    await expect(adapter.runOnce()).resolves.toEqual({ published: 1, skipped: 0 });
    await expect(adapter.runOnce()).resolves.toEqual({ published: 0, skipped: 1 });
    const evidencePage = await evidence.read({ limit: 100 });
    expect(evidencePage.items).toHaveLength(1);
    expect(evidencePage.items[0]).toMatchObject({
      schemaRef: "pragma.memory.execution-message/v2",
      payload: { message: { role: "assistant", text: "hello memory", stopReason: "stop" } },
      subjectRefs: expect.arrayContaining([
        { type: "pragma.flow", id: "flow" },
        { type: "pragma.expert", id: "producer-expert" },
      ]),
      bindings: expect.arrayContaining([
        { consumerRef: { type: "pragma.flow", id: "flow" }, access: "allow" },
        { consumerRef: { type: "pragma.expert", id: "producer-expert" }, access: "allow" },
      ]),
      attribution: {
        rootRef: { type: "pragma.flow", id: "flow" },
        producerRefs: [{ type: "pragma.expert", id: "producer-expert" }],
      },
      policySnapshot: {
        capture: true,
        recall: true,
        learning: "local-candidates",
        appliedRevisions: expect.any(Array),
      },
    });
    expect(JSON.stringify(evidencePage.items[0])).not.toMatch(
      /private reasoning|must-not-enter-memory|private-signature|diagnostics/,
    );

    const registry = new MemoryModuleRegistry();
    registry.register(createProbeMemoryModule({ pragmaHome: home }));
    registry.register(
      createProbeMemoryModule({
        pragmaHome: home,
        id: "pragma.memory.failing-probe",
        prefix: "failing-probe",
        fail: true,
      }),
    );
    const scheduler = createMemoryPipelineScheduler({
      registry,
      feed: evidence,
      publisher,
      checkpoints: state,
      deadLetters: state,
      outbox: state,
      now,
    });
    await scheduler.runOnce();
    for (let attempt = 1; attempt < 5; attempt += 1) {
      currentTime = new Date(currentTime.getTime() + 20_000);
      await scheduler.runOnce();
    }
    await expect(state.list("pragma.memory.failing-probe")).resolves.toHaveLength(1);

    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: () => ({
        rootRef: { type: "pragma.flow", id: "flow" },
        expertRef: { type: "pragma.expert", id: "producer-expert" },
      }),
    });
    const probe = await context.readContext({ id: "probe/items/entries.md" });
    expect(probe).toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("# Probe Evidence") },
    });
    expect(
      probe.ok && probe.value.content.split("\n").filter((line) => line.startsWith("- ")),
    ).toHaveLength(1);
    await expect(context.readContext({ id: "catalog.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("pragma.memory.failing-probe") },
    });
    await expect(context.addContext({ id: "manual.md", content: "no" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    canonical.close();
  });

  it("advances the canonical cursor without publishing evidence when capture is disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-disabled-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    const executions = createFileExecutionStore({
      pragmaHome: home,
      canonicalEventFeed: canonical,
    });
    const now = () => new Date("2000-01-01T00:00:00.000Z");
    const policies = createFileMemoryPolicyStore({ pragmaHome: home, now });
    await policies.updateGlobal({
      expectedRevision: 0,
      policy: { capture: "disabled", recall: "enabled", learning: "local-candidates" },
    });
    await createExecution(executions);
    await executions.appendEvent(
      "execution",
      "root",
      "invocation.message.appended",
      { message: { role: "user", content: "do not capture", timestamp: 1 } },
      "disabled-message",
    );
    const state = createFileMemoryPipelineStateStore({ pragmaHome: home, now });
    const evidence = createMemoryEvidenceFeed(canonical);
    const adapter = createExecutionEvidenceAdapter({
      source: canonical,
      publisher: createMemoryEvidencePublisher(canonical),
      checkpoints: state,
      deadLetters: state,
      policies,
      now,
    });

    await expect(adapter.runOnce()).resolves.toEqual({ published: 0, skipped: 1 });
    await expect(evidence.read({ limit: 100 })).resolves.toMatchObject({ items: [] });
    await expect(state.read("pragma.memory.execution-evidence-adapter")).resolves.toMatchObject({
      sequence: 1,
      processed: 0,
      skipped: 1,
    });
    canonical.close();
  });

  it.each([
    ["before outbox persistence", "outbox-before", 2],
    ["after outbox persistence", "outbox-after", 1],
    ["during derived event publication", "publish", 1],
    ["during checkpoint persistence", "checkpoint", 1],
  ] as const)("recovers a crash %s", async (_label, failurePoint, expectedConsumes) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-outbox-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    const durablePublisher = createMemoryEvidencePublisher(canonical);
    await durablePublisher.publish([
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "evidence-one",
        topic: "execution.message.appended",
        schemaRef: "pragma.memory.execution-message/v1",
        sourceRef: {
          type: "pragma.test-source",
          id: "source-one",
          canonicalEventId: "canonical-one",
        },
        subjectRefs: [{ type: "pragma.execution", id: "execution-one" }],
        occurredAt: "2026-08-01T00:00:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [],
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [{ scope: "global", revision: 0 }],
        },
        payload: { message: { role: "user", content: "durable memory", timestamp: 1 } },
      }),
    ]);
    await canonical.append([
      CanonicalEventEnvelopeSchema.parse({
        schemaVersion: "pragma.canonical-event/v1",
        eventId: "future-memory-envelope",
        topic: "pragma.memory.evidence.committed",
        schemaRef: "pragma.memory-evidence/v2",
        sourceRef: { type: "pragma.test-source", id: "future-source" },
        occurredAt: "2026-08-01T00:00:00.000Z",
        payload: { schemaVersion: "pragma.memory-evidence/v2" },
      }),
    ]);

    const state = createFileMemoryPipelineStateStore({ pragmaHome: home });
    let armed = true;
    const outbox: MemoryDerivedEventOutboxStore = {
      async enqueue(entry) {
        if (armed && failurePoint === "outbox-before") {
          armed = false;
          throw new Error("injected before outbox write");
        }
        await state.enqueue(entry);
        if (armed && failurePoint === "outbox-after") {
          armed = false;
          throw new Error("injected after outbox write");
        }
      },
      listPending: state.listPending,
      acknowledge: state.acknowledge,
    };
    const publisher: MemoryEvidencePublisher = {
      async publish(events) {
        if (armed && failurePoint === "publish") {
          armed = false;
          throw new Error("injected publish failure");
        }
        await durablePublisher.publish(events);
      },
    };
    const checkpoints: MemoryConsumerCheckpointStore = {
      read: state.read,
      async update(consumerId, updater) {
        if (armed && failurePoint === "checkpoint") {
          armed = false;
          throw new Error("injected checkpoint failure");
        }
        return await state.update(consumerId, updater);
      },
    };
    const registry = new MemoryModuleRegistry();
    const probe = createProbeMemoryModule({ pragmaHome: home });
    let consumeCount = 0;
    registry.register({
      ...probe,
      async consume(envelopes) {
        consumeCount += 1;
        return await probe.consume(envelopes);
      },
    });
    const scheduler = createMemoryPipelineScheduler({
      registry,
      feed: createMemoryEvidenceFeed(canonical),
      publisher,
      checkpoints,
      deadLetters: state,
      outbox,
    });

    await scheduler.runOnce();
    expect(registry.diagnostic("pragma.memory.probe")?.status).toBe("unavailable");
    await scheduler.runOnce();
    await scheduler.runOnce();

    expect(consumeCount).toBe(expectedConsumes);
    await expect(state.listPending("pragma.memory.probe")).resolves.toEqual([]);
    await expect(canonical.inspect()).resolves.toMatchObject({ lastSequence: 3, eventCount: 3 });
    expect(registry.diagnostic("pragma.memory.probe")).toMatchObject({
      status: "healthy",
      cursor: { sequence: 3 },
      lag: 0,
    });
    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: () => ({
        rootRef: { type: "pragma.expert", id: "producer-expert" },
        expertRef: { type: "pragma.expert", id: "producer-expert" },
      }),
    });
    const record = await context.readContext({ id: "probe/items/entries.md" });
    expect(record.ok && record.value.content.match(/^- /gm)).toHaveLength(1);
    canonical.close();
  });

  it("migrates legacy dead letters and removes expired content", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-dead-letters-"));
    const consumerId = "pragma.memory.legacy-consumer";
    const moduleRoot = new PragmaPaths({ pragmaHome: home }).memoryModuleStateRoot(consumerId);
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(
      join(moduleRoot, "dead-letters.json"),
      JSON.stringify([
        {
          schemaVersion: "pragma.memory-dead-letter/v1",
          consumerId,
          messageId: "old-message",
          sequence: 1,
          errorCode: "old_failure",
          failedAt: "2026-06-01T00:00:00.000Z",
        },
      ]),
    );
    const state = createFileMemoryPipelineStateStore({ pragmaHome: home });

    await expect(state.list(consumerId)).resolves.toHaveLength(1);
    await expect(state.maintain(new Date("2026-08-04T00:00:00.000Z"))).resolves.toEqual({
      deletedDeadLetters: 1,
    });
    await expect(state.list(consumerId)).resolves.toEqual([]);
    await expect(state.inspectDeadLetters()).resolves.toEqual({ entries: 0, bytes: 0 });
  });

  it("closes the SQLite handle when legacy dead-letter validation fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-invalid-dead-letters-"));
    const consumerId = "pragma.memory.invalid-legacy-consumer";
    const moduleRoot = new PragmaPaths({ pragmaHome: home }).memoryModuleStateRoot(consumerId);
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(
      join(moduleRoot, "dead-letters.json"),
      JSON.stringify([{ schemaVersion: "pragma.memory-dead-letter/v1", consumerId }]),
    );
    const state = createFileMemoryPipelineStateStore({ pragmaHome: home });

    await expect(state.list(consumerId)).rejects.toThrow();
    const database = new DatabaseSync(join(moduleRoot, "dead-letters.sqlite"));
    expect(
      (
        database.prepare("PRAGMA user_version").get() as unknown as {
          readonly user_version: number;
        }
      ).user_version,
    ).toBe(1);
    database.close();
  });
});

async function createExecution(store: ReturnType<typeof createFileExecutionStore>) {
  const timestamp = new Date().toISOString();
  const definition = { id: "flow", kind: "flow" as const };
  const execution: ExecutionRecord = {
    schemaVersion: "pragma.execution/v9",
    executionId: "execution",
    version: 0,
    kind: "flow",
    definition,
    rootInvocationId: "root",
    status: "running",
    input: null,
    state: {},
    lastAppliedSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const root: Invocation = {
    invocationId: "root",
    rootInvocationId: "root",
    contextId: "root-context",
    definition,
    status: "running",
    input: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.create(execution, root);
  await store.commit({
    commitId: "bind-root-context",
    executionId: "execution",
    contextPuts: [
      {
        schemaVersion: "pragma.runtime-context/v5",
        contextId: "root-context",
        owner: { type: "flow-execution", ownerId: "execution" },
        origin: { type: "invocation", invocationId: "root" },
        expert: { id: "producer-expert" },
        runtime: { runtimeId: "test", revision: 1, fingerprint: "a".repeat(64) },
        lifecycle: "open",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
}
