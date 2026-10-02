import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestExecutionStore } from "./execution-test-host.ts";

import { createFileCanonicalEventFeed } from "@pragma/core";
import { type ExecutionRecord, type Invocation } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  createExecutionEvidenceAdapter,
  createFederatedMemoryContextStore,
  createFileMemoryPipelineStateStore,
  createFileMemoryPolicyStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  MemoryModuleRegistry,
} from "@pragma/memory";
import { createProbeMemoryModule } from "@pragma/memory/testing";

describe("Host Memory Execution integration", () => {
  it("adapts canonical events, isolates modules, and exposes Probe through Context", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-plane-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    const executions = createTestExecutionStore({
      pragmaHome: home,
      canonicalEventFeed: canonical,
    });
    await createExecution(executions);
    await appendExecutionEvent(
      executions,
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
    await policies.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
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
    await executions.drainCanonicalEvents();
    await expect(adapter.runOnce()).resolves.toEqual({ published: 1, skipped: 0 });
    await executions.drainCanonicalEvents();
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
      ok: false,
      error: { code: "context_not_found" },
    });
    await expect(context.addContext({ id: "manual.md", content: "no" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    await canonical.close();
  });
  it("advances the canonical cursor without publishing evidence when capture is disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-disabled-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    const executions = createTestExecutionStore({
      pragmaHome: home,
      canonicalEventFeed: canonical,
    });
    const now = () => new Date("2000-01-01T00:00:00.000Z");
    const policies = createFileMemoryPolicyStore({ pragmaHome: home, now });
    await policies.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "disabled",
        capture: "disabled",
        recall: "disabled",
        learning: "disabled",
      },
    });
    await createExecution(executions);
    await appendExecutionEvent(
      executions,
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

    await executions.drainCanonicalEvents();
    await expect(adapter.runOnce()).resolves.toEqual({ published: 0, skipped: 1 });
    await expect(evidence.read({ limit: 100 })).resolves.toMatchObject({ items: [] });
    await expect(state.read("pragma.memory.execution-evidence-adapter")).resolves.toMatchObject({
      sequence: 1,
      processed: 0,
      skipped: 1,
    });
    await canonical.close();
  });
  it("captures enabled occurrence-time events after the global policy is disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-occurrence-policy-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    const executions = createTestExecutionStore({
      pragmaHome: home,
      canonicalEventFeed: canonical,
    });
    let currentTime = new Date(Date.now() - 60_000);
    const now = () => currentTime;
    const policies = createFileMemoryPolicyStore({ pragmaHome: home, now });
    await policies.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    await createExecution(executions);
    await appendExecutionEvent(
      executions,
      "execution",
      "root",
      "invocation.message.appended",
      { message: { role: "user", content: "capture before disable", timestamp: 1 } },
      "enabled-before-disable",
    );
    currentTime = new Date(Date.now() + 60_000);
    await policies.updateGlobal({
      expectedRevision: 1,
      policy: {
        enabled: "disabled",
        capture: "disabled",
        recall: "disabled",
        learning: "disabled",
      },
    });

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

    await executions.drainCanonicalEvents();
    await expect(adapter.runOnce()).resolves.toEqual({ published: 1, skipped: 0 });
    await expect(evidence.read({ limit: 100 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          sourceRef: expect.objectContaining({ id: "enabled-before-disable" }),
          policySnapshot: expect.objectContaining({ capture: true }),
        }),
      ],
    });
    await canonical.close();
  });
});
async function appendExecutionEvent(
  store: ReturnType<typeof createTestExecutionStore>,
  executionId: string,
  invocationId: string,
  type: string,
  data: unknown,
  eventId: string = crypto.randomUUID(),
): Promise<void> {
  await store.commit({
    commitId: `event:${eventId}`,
    executionId,
    events: [{ eventId, invocationId, type, data }],
  });
}
async function createExecution(store: ReturnType<typeof createTestExecutionStore>) {
  const timestamp = new Date().toISOString();
  const definition = { id: "flow", kind: "flow" as const };
  const execution: ExecutionRecord = {
    schemaVersion: "pragma.execution/v12",
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
    pendingExpertMessages: [],
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
