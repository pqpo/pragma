import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createFileCanonicalEventFeed, PragmaPaths, StaticContextStore } from "@pragma/core";
import { CanonicalEventEnvelopeSchema, MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  createFederatedMemoryContextStore,
  createFileMemoryPipelineStateStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  MemoryModuleRegistry,
  type MemoryConsumerCheckpointStore,
  type MemoryDerivedEventOutboxStore,
  type MemoryEvidencePublisher,
} from "../src/index.ts";
import { createProbeMemoryModule } from "../src/testing/index.ts";

describe("Memory Plane phase one", () => {
  it("keeps a useful fragment when a module summary is one oversized line", async () => {
    const registry = new MemoryModuleRegistry();
    const probe = createProbeMemoryModule({
      id: "pragma.memory.single-line",
      prefix: "single-line",
    });
    registry.register({
      ...probe,
      descriptor: {
        ...probe.descriptor,
        contextLayers: { ...probe.descriptor.contextLayers, summaryMaxBytes: 16 },
      },
      createContextProvider: () =>
        new StaticContextStore([
          {
            id: "summary.md",
            content: "single-line-summary-that-exceeds-the-budget",
            metadata: { trigger: "model_decision", priority: "normal" },
          },
          {
            id: "index.md",
            content: "# Index\n",
            metadata: { trigger: "model_decision", priority: "low" },
          },
        ]),
    });
    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: () => ({
        rootRef: { type: "pragma.expert", id: "expert" },
        expertRef: { type: "pragma.expert", id: "expert" },
      }),
    });

    await expect(context.readContext({ id: "overview.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: expect.stringMatching(/single-line-.*…/) },
    });
  });

  it("uses each evidence policy snapshot instead of skipping a mixed-policy backlog", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-pipeline-disabled-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    const publisher = createMemoryEvidencePublisher(canonical);
    await publisher.publish([
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "pipeline-disabled-evidence",
        topic: "execution.message.appended",
        schemaRef: "pragma.memory.execution-message/v1",
        sourceRef: {
          type: "pragma.test-source",
          id: "pipeline-disabled-source",
          canonicalEventId: "pipeline-disabled-canonical",
        },
        subjectRefs: [{ type: "pragma.execution", id: "pipeline-disabled-execution" }],
        occurredAt: "2026-08-01T00:00:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [],
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "disabled",
          appliedRevisions: [],
        },
        payload: { message: { role: "user", content: "pipeline disabled", timestamp: 1 } },
      }),
    ]);
    await publisher.publish([
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "pipeline-enabled-evidence",
        topic: "execution.message.appended",
        schemaRef: "pragma.memory.execution-message/v1",
        sourceRef: {
          type: "pragma.test-source",
          id: "pipeline-enabled-source",
          canonicalEventId: "pipeline-enabled-canonical",
        },
        subjectRefs: [{ type: "pragma.execution", id: "pipeline-enabled-execution" }],
        occurredAt: "2026-08-01T00:00:01.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [],
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [],
        },
        payload: { message: { role: "user", content: "pipeline enabled", timestamp: 2 } },
      }),
    ]);

    const state = createFileMemoryPipelineStateStore({ pragmaHome: home });
    const registry = new MemoryModuleRegistry();
    const probe = createProbeMemoryModule({ pragmaHome: home });
    const consumedMessageIds: string[] = [];
    registry.register({
      ...probe,
      descriptor: { ...probe.descriptor, purpose: "learning" },
      async consume(envelopes) {
        consumedMessageIds.push(...envelopes.map((envelope) => envelope.messageId));
        return await probe.consume(envelopes);
      },
    });
    const scheduler = createMemoryPipelineScheduler({
      registry,
      feed: createMemoryEvidenceFeed(canonical),
      publisher,
      checkpoints: state,
      deadLetters: state,
      outbox: state,
    });

    await scheduler.runOnce();
    expect(registry.diagnostic("pragma.memory.probe")).toMatchObject({
      status: "healthy",
      lag: 0,
    });
    expect((await state.read("pragma.memory.probe")).sequence).toBe(2);
    expect(consumedMessageIds).toEqual(["pipeline-enabled-evidence"]);
    await canonical.close();
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
    await canonical.close();
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
