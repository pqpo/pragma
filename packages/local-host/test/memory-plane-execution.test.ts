import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestExecutionStore } from "./execution-test-host.ts";

import { createFileCanonicalEventFeed, createPragmaLogger, PragmaPaths } from "@pragma/core";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
  ContextStoreRevisionJobSchema,
  ManagedSkillRevisionJobSchema,
} from "@pragma/built-in-agents";
import { createLocalHostMemoryDataPlane } from "../src/memory-data-plane.ts";
import { createMissionDelivery } from "../src/missions/mission-delivery.ts";
import { createMissionStore } from "../src/missions/repository/mission-store.ts";
import {
  MemoryToolContentPayloadSchema,
  type ExecutionRecord,
  type Invocation,
} from "@pragma/shared";
import { describe, expect, it } from "vitest";

import {
  createExecutionEvidenceAdapter,
  createFileMemoryExtractionSettingsStore,
  selectMemoryExtractionEvidence,
  createMemoryExtractionSessionStore,
  createFederatedMemoryContextStore,
  createFileMemoryPipelineStateStore,
  createFileMemoryPolicyStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  MemoryModuleRegistry,
} from "@pragma/memory";
import { createProbeMemoryModule } from "@pragma/memory/testing";

it.each([
  [SKILL_REVISION_EXPERT_REF, "system-memory", "user"],
  [STORE_REVISION_EXPERT_REF, "system-memory", "user"],
  [SKILL_REVISION_EXPERT_REF, "user", "user"],
  [STORE_REVISION_EXPERT_REF, "user", "user"],
  [SKILL_REVISION_EXPERT_REF, "system-skill-revision", "user"],
  [STORE_REVISION_EXPERT_REF, "system-store-revision", "user"],
  [SKILL_REVISION_EXPERT_REF, "system-skill-revision", "memory-learning"],
  [STORE_REVISION_EXPERT_REF, "system-store-revision", "memory-learning"],
] as const)("captures %s only for user work (%s, %s)", async (ref, originType, source) => {
  const root = await mkdtemp(join(tmpdir(), "pragma-planning-capture-"));
  const logger = createPragmaLogger(undefined, { component: "test.planning-capture" });
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const mission = await missions.create({
    workspace: { path: root, basename: "workspace" },
    goal: "Plan Memory Skill", // A title must never determine whether user work is captured.
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref, name: "Revision Agent" },
    origin:
      originType === "system-memory"
        ? { type: "system-memory", jobId: `plan:${randomUUID()}` }
        : originType === "system-skill-revision"
          ? { type: "system-skill-revision", jobId: randomUUID(), capabilityId: ref.slice(7) }
          : originType === "system-store-revision"
            ? { type: "system-store-revision", jobId: randomUUID(), storeId: randomUUID() }
            : { type: "user" },
  });
  let delivery: Awaited<ReturnType<typeof createMissionDelivery>> | undefined;
  let data = await createLocalHostMemoryDataPlane({ pragmaHome: root, logger });
  const closeData = async () => {
    await data.scheduler.stop();
    data.episodic.close();
    data.semantic.close();
    data.knowledge.close();
    data.skill.close();
    await data.executionStore.close?.();
    await data.canonical.close();
  };
  const executionId = randomUUID();
  try {
    await data.policies.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    const occurredAt = new Date().toISOString();
    await data.canonical.append(
      ["invocation.message.appended", "execution.succeeded"].map((type, index) => ({
        schemaVersion: "pragma.canonical-event/v1" as const,
        eventId: randomUUID(),
        topic: "pragma.execution.event.committed",
        schemaRef: "pragma.execution-event/v5",
        sourceRef: { type: "pragma.execution-event", id: `${executionId}:${index}` },
        relatedRefs: [
          {
            relation: "pragma.execution-root",
            ref: { type: "pragma.expert", id: ref.slice("expert:".length) },
          },
        ],
        correlationId: executionId,
        occurredAt,
        payload: {
          schemaVersion: "pragma.execution-event/v5",
          eventId: `${executionId}:${index}`,
          cursor: { executionId, sequence: index + 1 },
          executionId,
          invocationId: executionId,
          type,
          occurredAt,
          data:
            index === 0
              ? { message: { role: "user", content: "Plan this workflow", timestamp: 1 } }
              : {},
        },
      })),
    );
    await expect(data.flushDelivery()).resolves.toEqual({ published: 0, skipped: 0, deferred: 2 });
    expect(await data.episodic.store.listExtractionJobs()).toHaveLength(0);
    expect(await data.semantic.store.listExtractionJobs()).toHaveLength(0);

    delivery = await createMissionDelivery({
      path: new PragmaPaths({ pragmaHome: root }).missionDelivery(),
      feed: data.canonical,
      logger,
      usage: async () => undefined,
      terminal: async () => undefined,
    });
    await delivery.register(mission, executionId, randomUUID());
    await delivery.close();
    // Reopen the durable admission link: exclusion must survive a Host restart.
    delivery = await createMissionDelivery({
      path: new PragmaPaths({ pragmaHome: root }).missionDelivery(),
      feed: data.canonical,
      logger,
      usage: async () => undefined,
      terminal: async () => undefined,
    });
    const receiptPath = new PragmaPaths({ pragmaHome: root }).missionDelivery();
    const db = new DatabaseSync(receiptPath);
    const saved = db
      .prepare("SELECT payload FROM execution_links WHERE execution_id=?")
      .get(executionId) as { payload: string };
    db.prepare("UPDATE execution_links SET payload=? WHERE execution_id=?").run("{", executionId);
    await expect(data.flushDelivery()).resolves.toEqual({ published: 0, skipped: 0, deferred: 2 });
    db.prepare("UPDATE execution_links SET payload=? WHERE execution_id=?").run(
      saved.payload,
      executionId,
    );
    db.close();
    await closeData();
    data = await createLocalHostMemoryDataPlane({ pragmaHome: root, logger });
    expect(await data.deferredCapture.inspect()).toEqual({ pending: 2, safeThrough: 0 });
    // Legacy Revision origins require their authority job to distinguish
    // interactive work from automatic memory-learning. Missing owners defer.
    const paths = new PragmaPaths({ pragmaHome: root });
    const origin = mission.origin;
    if (origin.type === "system-store-revision" || origin.type === "system-skill-revision") {
      await expect(data.flushDelivery()).resolves.toEqual({
        published: 0,
        skipped: 0,
        deferred: 2,
      });
      const common = {
        id: origin.jobId,
        revision: 1,
        draftId: randomUUID(),
        missionId: mission.id,
        state: "running",
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      const job =
        origin.type === "system-store-revision"
          ? ContextStoreRevisionJobSchema.parse({
              ...common,
              schemaVersion: "pragma.context-store-revision-job/v4",
              request: {
                schemaVersion: "pragma.context-store-revision-request/v2",
                operation: "revise",
                storeId: origin.storeId,
                prompt: "Revise authorized guidance",
                source,
                ...(source === "memory-learning" ? { sourceDigest: "a".repeat(64) } : {}),
              },
            })
          : ManagedSkillRevisionJobSchema.parse({
              ...common,
              schemaVersion: "pragma.skill-revision-job/v5",
              request: {
                schemaVersion: "pragma.skill-revision-request/v4",
                operation: "revise",
                capabilityId: origin.capabilityId,
                prompt: "Revise authorized guidance",
                source,
                sourceDigest: "a".repeat(64),
                sourceRefs: [],
              },
            });
      const directory = join(
        paths.stateRoot(),
        origin.type === "system-store-revision" ? "context-store-revisions" : "skill-revisions",
        "jobs",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${origin.jobId}.json`), JSON.stringify(job));
    }
    const capture = originType !== "system-memory" && source !== "memory-learning";
    if (capture) {
      await data.registerExecutionContext({
        executionId,
        missionId: mission.id,
        projectId: "studio",
      });
    }
    await expect(data.flushDelivery()).resolves.toEqual({
      published: capture ? 2 : 0,
      skipped: capture ? 0 : 2,
    });
    expect(await data.episodic.store.listExtractionJobs()).toHaveLength(capture ? 1 : 0);
    expect(await data.semantic.store.listExtractionJobs()).toHaveLength(capture ? 1 : 0);
    expect((await data.activity.summarize(executionId)).capture).toMatchObject({
      published: capture ? 2 : 0,
      skipped: capture ? 0 : 2,
    });
  } finally {
    await delivery?.close();
    await closeData();
    await rm(root, { recursive: true, force: true });
  }
});

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
  it("captures authorized tool text across the real Execution and Feed boundary and reads it through extraction tools", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-tool-text-"));
    const canonical = await createFileCanonicalEventFeed({ pragmaHome: home });
    try {
      const executions = createTestExecutionStore({
        pragmaHome: home,
        canonicalEventFeed: canonical,
      });
      const policies = createFileMemoryPolicyStore({
        pragmaHome: home,
        now: () => new Date("2000-01-01T00:00:00.000Z"),
      });
      await policies.updateGlobal({
        expectedRevision: 0,
        policy: {
          enabled: "enabled",
          capture: "enabled",
          recall: "enabled",
          learning: "local-candidates",
        },
      });
      const extractionSettings = createFileMemoryExtractionSettingsStore({ pragmaHome: home });
      await extractionSettings.update({
        expectedRevision: 0,
        allowToolAssisted: { episodic: false, semantic: true },
      });
      const privateKey = generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const githubToken = "ghp_" + "A".repeat(36);
      const slackToken = "xoxb-" + "1".repeat(13) + "-" + "2".repeat(13) + "-" + "a".repeat(24);
      const riskyText = `Useful tool result. api_key=secret-value\n${privateKey}\n${githubToken}\n${slackToken}`;
      await createExecution(executions);
      await appendExecutionEvent(
        executions,
        "execution",
        "root",
        "invocation.message.appended",
        {
          message: {
            role: "toolResult",
            toolCallId: "tool-text",
            toolName: "lookup",
            content: [{ type: "text", text: riskyText }],
            isError: false,
            timestamp: 1,
          },
        },
        "tool-message",
      );
      for (const type of ["tool.started", "tool.completed"] as const) {
        await appendExecutionEvent(
          executions,
          "execution",
          "root",
          "runtime.event",
          {
            schemaVersion: "pragma.stream/v1",
            eventId: `preview-${type}`,
            sequence: 1,
            runId: "run",
            emittedAt: new Date().toISOString(),
            source: { kind: "runtime", runId: "run", path: [] },
            type,
            payload: {
              toolCallId: "preview",
              toolName: "lookup",
              ...(type === "tool.started"
                ? { inputPreview: { nested: riskyText } }
                : {
                    outputPreview: {
                      details: { repeated: riskyText, hostOnly: "host-only-marker" },
                      content: [
                        { type: "image", mimeType: "image/png", data: "A".repeat(70_000) },
                        { type: "audio", mimeType: "audio/wav", data: "B".repeat(70_000) },
                        {
                          type: "resource",
                          resource: { uri: "file:///data.bin", blob: "C".repeat(70_000) },
                        },
                        { type: "text", text: riskyText },
                        {
                          type: "resource",
                          resource: { uri: "file:///notes.txt", text: "Useful resource notes" },
                        },
                        { type: "resource_link", uri: "file:///report.pdf", name: "Report" },
                      ],
                    },
                  }),
            },
          },
          `preview-${type}`,
        );
      }
      const state = createFileMemoryPipelineStateStore({ pragmaHome: home });
      let settingsUnavailable = true;
      const adapter = createExecutionEvidenceAdapter({
        source: canonical,
        publisher: createMemoryEvidencePublisher(canonical),
        checkpoints: state,
        deadLetters: state,
        policies,
        extractionSettings: {
          get: async () => {
            if (settingsUnavailable) throw new Error("settings_unavailable");
            return await extractionSettings.get();
          },
        },
      });
      await executions.drainCanonicalEvents();
      await expect(adapter.runOnce()).rejects.toThrow("settings_unavailable");
      expect((await state.read("pragma.memory.execution-evidence-adapter")).sequence).toBe(0);
      expect(await state.list("pragma.memory.execution-evidence-adapter")).toHaveLength(0);
      settingsUnavailable = false;
      expect((await adapter.runOnce()).published).toBe(6);
      const page = await createMemoryEvidenceFeed(canonical).read({ limit: 100 });
      const selected = selectMemoryExtractionEvidence(page.items, true, "semantic");
      const content = selected.retained.find(
        (item) => item.schemaRef === "pragma.memory.tool-content/v1",
      )!;
      expect(content.payload).toMatchObject({
        allowedModules: ["semantic"],
        completeness: "full",
        text: expect.stringContaining("[REDACTED_CREDENTIAL]"),
      });
      const captured = JSON.stringify(page.items);
      expect(captured).not.toContain("host-only-marker");
      const toolContents = selected.retained.filter(
        (item) => item.schemaRef === "pragma.memory.tool-content/v1",
      );
      expect(toolContents).toHaveLength(3);
      for (const item of toolContents)
        expect(JSON.stringify(item.payload).match(/Useful tool result/g)).toHaveLength(1);
      const previewContent = toolContents.find((item) => {
        const payload = MemoryToolContentPayloadSchema.parse(item.payload);
        return payload.toolCallId === "preview" && payload.phase === "completed";
      })!;
      expect(previewContent.payload).toMatchObject({
        completeness: "preview",
        text: expect.stringContaining("Useful resource notes"),
      });
      expect(JSON.stringify(previewContent.payload)).toContain("file:///report.pdf");
      for (const media of ["A", "B", "C"]) expect(captured).not.toContain(media.repeat(100));
      for (const secret of [
        "secret-value",
        privateKey.trim(),
        ...privateKey.trim().split("\n").slice(1, -1),
        githubToken,
        slackToken,
      ])
        expect(captured).not.toContain(secret);
      expect(captured).toContain("[REDACTED_PRIVATE_KEY]");

      expect(selectMemoryExtractionEvidence(page.items, true, "episodic").retained).toHaveLength(3);
      expect(selectMemoryExtractionEvidence(page.items, false, "semantic").retained).toHaveLength(
        3,
      );
      const session = await createMemoryExtractionSessionStore({ pragmaHome: home }).create({
        module: "semantic",
        watermark: "tool",
        input: {
          schemaVersion: "pragma.memory-semantic-extraction-input/v3",
          jobId: "tool",
          executionId: "execution",
          allowedSubjectRefs: [{ type: "pragma.user", id: "user" }],
          currentFacts: [],
          evidence: [previewContent],
          omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
        },
      });
      expect(await session.call("read_evidence", { evidence: "e1" })).toContain(
        "Useful tool result",
      );
      await extractionSettings.update({
        expectedRevision: 1,
        allowToolAssisted: { episodic: false, semantic: false },
      });
      await appendExecutionEvent(
        executions,
        "execution",
        "root",
        "invocation.message.appended",
        {
          message: {
            role: "toolResult",
            toolCallId: "later",
            toolName: "lookup",
            content: [{ type: "text", text: "Never captured" }],
            isError: false,
            timestamp: 2,
          },
        },
        "later-tool",
      );
      await executions.drainCanonicalEvents();
      await adapter.runOnce();
      const all = await createMemoryEvidenceFeed(canonical).read({ limit: 100 });
      expect(
        all.items.filter((item) => item.schemaRef === "pragma.memory.tool-content/v1"),
      ).toHaveLength(3);
    } finally {
      await canonical.close();
      await rm(home, { recursive: true, force: true });
    }
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
