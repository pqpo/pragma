import { resolveMemoryRecallScope, type SecretStore } from "@pragma/local-host";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLoggerProvider,
  createPragmaLogger,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  PragmaPaths,
} from "@pragma/core";
import {
  CanonicalEventEnvelopeSchema,
  MemoryEvidenceEnvelopeSchema,
  type PragmaLogRecord,
} from "@pragma/shared";
import { SKILL_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopMemoryPlane,
  resolveMemoryModuleHealthStatus,
} from "./desktop-memory-plane.ts";

const roots: string[] = [];
const backgroundSettlementTimeoutMs = 5_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(
      async (root) =>
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        }),
    ),
  );
});

describe("DesktopMemoryPlane", { timeout: 30_000 }, () => {
  it("reports deferred capture without blocking normal extraction and protects its source during maintenance", async () => {
    const pragmaHome = await temporaryRoot("pragma-memory-capture-isolation-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "test.capture-isolation" }),
      pollIntervalMs: 10,
    });
    try {
      await plane.policies.updateGlobal({
        expectedRevision: 0,
        policy: {
          enabled: "enabled",
          capture: "enabled",
          recall: "enabled",
          learning: "local-candidates",
        },
      });
      const event = (id: string, expert: string, occurredAt: string, terminal = false) =>
        CanonicalEventEnvelopeSchema.parse({
          schemaVersion: "pragma.canonical-event/v1",
          eventId: terminal ? `${id}:terminal` : id,
          topic: "pragma.execution.event.committed",
          schemaRef: "pragma.execution-event/v5",
          sourceRef: { type: "pragma.execution-event", id },
          relatedRefs: [
            { relation: "pragma.execution-root", ref: { type: "pragma.expert", id: expert } },
          ],
          correlationId: id,
          occurredAt,
          payload: {
            schemaVersion: "pragma.execution-event/v5",
            eventId: terminal ? `${id}:terminal` : id,
            cursor: { executionId: id, sequence: terminal ? 2 : 1 },
            executionId: id,
            invocationId: id,
            type: terminal ? "execution.succeeded" : "invocation.message.appended",
            occurredAt,
            data: { message: { role: "user", content: id, timestamp: 1 } },
          },
        });
      await plane.registerMemoryExecutionContext({
        executionId: "normal",
        missionId: "normal-mission",
        projectId: "studio",
      });
      await plane.canonical.append([
        event("unresolved", SKILL_REVISION_EXPERT_REF.slice(7), "2020-01-01T00:00:00.000Z"),
        event("normal", "7k2m9q4v8np6r3dt", new Date().toISOString()),
        event("normal", "7k2m9q4v8np6r3dt", new Date().toISOString(), true),
      ]);
      plane.start();
      await vi.waitFor(async () => {
        expect((await plane.getStatus()).modules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              moduleId: "pragma.memory.execution-evidence-adapter",
              status: "degraded",
              lag: 1,
              lastErrorCode: "memory_execution_origin_unavailable",
            }),
          ]),
        );
        expect(await plane.episodicStore.listExtractionJobs()).toHaveLength(1);
      });
      await plane.maintainStorage();
      expect((await plane.getStatus()).feed.safeThroughSequence).toBe(0);
      expect((await plane.canonical.read({ limit: 1 })).items[0]).toMatchObject({
        kind: "event",
        event: { eventId: "unresolved" },
      });
      await plane.canonical.forgetCorrelation("unresolved");
      plane.wakePipeline();
      await vi.waitFor(async () => {
        expect((await plane.getStatus()).modules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              moduleId: "pragma.memory.execution-evidence-adapter",
              status: "healthy",
              lag: 0,
            }),
          ]),
        );
      });
    } finally {
      await plane.stop();
    }
  });
  it("retains the newest 50 completed task records without age expiry", async () => {
    const pragmaHome = await temporaryRoot("pragma-memory-completed-retention-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
    });
    try {
      const old = new Date("2020-01-01T00:00:00.000Z");
      for (let index = 0; index < 55; index++) {
        await plane.knowledgeLearningStore.schedule({
          rootRef: { type: "pragma.expert", id: `expert-${index}` },
          sourceDigest: "a".repeat(64),
          now: old,
        });
        const finishedAt = new Date(old.getTime() + 24 * 60 * 60_000 + index * 1_000);
        const job = await plane.knowledgeLearningStore.claimDueJob(finishedAt);
        expect(job).toBeDefined();
        await plane.knowledgeLearningStore.completeRejected(job!, finishedAt);
      }
      await plane.maintainStorage();
      const jobs = await plane.knowledgeLearningStore.listJobs();
      expect(jobs).toHaveLength(50);
      expect(jobs.map((job) => job.rootRef.id)).not.toContain("expert-0");
      expect(jobs.map((job) => job.rootRef.id)).toContain("expert-54");
      await plane.maintainStorage();
      expect(await plane.knowledgeLearningStore.listJobs()).toHaveLength(50);
    } finally {
      await plane.stop();
    }
  });

  it("keeps Memory healthy without optional embedding configuration and diagnoses incomplete opt-in", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-optional-retrieval-");
    const unexpectedSecretAccess = vi.fn(async (): Promise<never> => {
      throw new Error("Unconfigured retrieval must not access secrets");
    });
    const secrets: SecretStore = {
      inspect: unexpectedSecretAccess,
      get: unexpectedSecretAccess,
      put: unexpectedSecretAccess,
      delete: unexpectedSecretAccess,
      listMetadata: unexpectedSecretAccess,
    };
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      secrets,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
    });
    try {
      plane.start();
      const initial = await plane.getStatus();
      expect(initial.state).toBe("running");
      expect(initial.lastError).toBeUndefined();
      expect(initial.modules.some((module) => module.moduleId === "pragma.memory.retrieval")).toBe(
        false,
      );

      await plane.retrieval!.settings.update({ expectedRevision: 0, enabled: true });
      await expect(plane.getStatus()).resolves.toMatchObject({
        state: "degraded",
        lastError: { code: "embedding_model_unavailable" },
      });

      await plane.retrieval!.settings.update({ expectedRevision: 1, enabled: false });
      const disabled = await plane.getStatus();
      expect(disabled.state).toBe("running");
      expect(disabled.lastError).toBeUndefined();
      expect(unexpectedSecretAccess).not.toHaveBeenCalled();
    } finally {
      await plane.stop();
    }
  });
  it.each(["knowledge", "canonical"] as const)(
    "retries a partial %s shutdown without closing successful real SQLite stores twice",
    async (failure) => {
      const pragmaHome = await temporaryRoot("pragma-desktop-memory-stop-retry-");
      const plane = await createDesktopMemoryPlane({
        pragmaHome,
        logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      });
      const episodic = vi.spyOn(plane.episodicStore, "close");
      const knowledge = vi.spyOn(plane.knowledgeLearningStore, "close");
      const skill = vi.spyOn(plane.skillLearningStore, "close");
      const semantic = vi.spyOn(plane.semanticStore, "close");
      const canonical = vi.spyOn(plane.canonical, "close");
      if (failure === "knowledge")
        knowledge.mockImplementationOnce(() => {
          throw new Error("SQLite close interrupted");
        });
      else canonical.mockRejectedValueOnce(new Error("Canonical close interrupted"));
      try {
        const first = plane.stop();
        expect(plane.stop()).toBe(first);
        await expect(first).rejects.toThrow("Memory resource shutdown failed.");
        await plane.stop();
        await plane.stop();
        expect(episodic).toHaveBeenCalledOnce();
        expect(skill).toHaveBeenCalledOnce();
        expect(semantic).toHaveBeenCalledOnce();
        expect(knowledge).toHaveBeenCalledTimes(failure === "knowledge" ? 2 : 1);
        expect(canonical).toHaveBeenCalledTimes(failure === "canonical" ? 2 : 1);
      } finally {
        await plane.stop();
      }
    },
  );
  it("is an always-available host service whose background loop starts explicitly", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
    });
    await plane.policies.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });

    await expect(plane.getStatus()).resolves.toMatchObject({
      state: "stopped",
      feed: { lastSequence: 0, eventCount: 0 },
      delivery: { pending: 0, quarantined: 0 },
      modules: [],
    });
    const view = await plane.createContextStoreView({
      rootRef: { type: "pragma.expert", id: "7k2m9q4v8np6r3dt" },
      expertRef: { type: "pragma.expert", id: "7k2m9q4v8np6r3dt" },
      projectId: "pragma",
    });
    const guide = await view.readContext({ id: "guide.md" });
    expect(guide.ok && guide.value.content).toContain("read-only");
    expect(guide.ok && guide.value.content).toContain("search_expert_context");
    expect(guide.ok && guide.value.content).not.toContain("knowledge-learning");
    const overview = await view.readContext({ id: "overview.md" });
    expect(overview.ok).toBe(true);
    if (overview.ok) {
      expect(overview.value.content.indexOf("Semantic Memory Summary")).toBeLessThan(
        overview.value.content.indexOf("Episodic Memory Summary"),
      );
      expect(Buffer.byteLength(overview.value.content, "utf8")).toBeLessThanOrEqual(4_096);
    }
    const listed = await view.listContext({});
    expect(
      listed.ok && listed.value.some((item) => item.id.startsWith("knowledge-learning/")),
    ).toBe(false);
    plane.start();
    await expect(plane.getStatus()).resolves.toMatchObject({ state: "running" });
    await plane.stop();
  });

  it("cleans only the deleted owner's transient state without global retention maintenance", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-delete-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
    });
    const maintain = vi.spyOn(plane.canonical, "maintain");
    await plane.deleteExecutionState(["deleted-execution"]);
    expect(maintain).not.toHaveBeenCalled();
    await plane.maintainStorage();
    expect(maintain).toHaveBeenCalledOnce();
    await plane.stop();
  });

  it("wakes the outer poll loop immediately after a policy change", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-wake-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      pollIntervalMs: 60_000,
    });
    const getGlobal = vi.spyOn(plane.policies, "getGlobal");
    plane.start();
    await vi.waitFor(() => expect(getGlobal).toHaveBeenCalled(), {
      timeout: backgroundSettlementTimeoutMs,
    });
    const callsBeforeWake = getGlobal.mock.calls.length;

    plane.wakePipeline();
    await vi.waitFor(() => expect(getGlobal.mock.calls.length).toBeGreaterThan(callsBeforeWake), {
      timeout: backgroundSettlementTimeoutMs,
    });
    await plane.stop();
  });

  it("reports a quarantined handoff as degraded without exposing its payload", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-degraded-");
    const paths = new PragmaPaths({ pragmaHome });
    const handoff = paths.canonicalEventHandoff("execution", "future");
    await mkdir(paths.canonicalEventHandoffsRoot(), { recursive: true });
    await writeFile(
      handoff,
      JSON.stringify({ schemaVersion: "pragma.canonical-event-handoff/v2" }),
    );
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
    });

    plane.start();
    await vi.waitFor(
      async () => {
        await expect(plane.getStatus()).resolves.toMatchObject({
          state: "degraded",
          delivery: { pending: 0, quarantined: 1 },
          lastError: { code: "canonical_event_handoff_quarantined" },
        });
      },
      { timeout: backgroundSettlementTimeoutMs },
    );
    await plane.stop();
  });

  it.each(["knowledge", "skill"] as const)(
    "rejects manual %s learning while disabled",
    async (module) => {
      const plane = await createDesktopMemoryPlane({
        pragmaHome: await temporaryRoot("pragma-learning-disabled-action-"),
        logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      });
      try {
        for (const action of ["expedite", "retry"] as const) {
          await expect(
            plane.manageMemoryJob({
              module,
              action,
              id: "job",
              expectedRevision: 1,
            }),
          ).rejects.toThrow("memory_learning_disabled");
        }
      } finally {
        await plane.stop();
      }
    },
  );

  it("reports extraction jobs that need attention as a degraded user-visible status", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-extraction-failed-");
    let onTick = async (): Promise<void> => {};
    const logs: PragmaLogRecord[] = [];
    const loggerProvider = createLoggerProvider({
      handler: { write: (record) => logs.push(record) },
      minimumLevel: "debug",
    });
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(loggerProvider, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
      onTick: async () => await onTick(),
    });
    await plane.policies.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    const now = new Date();
    await plane.episodicStore.ingest([
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "terminal-memory-extraction-failed",
        topic: "execution.execution.terminal",
        schemaRef: "pragma.memory.execution-terminal/v2",
        sourceRef: {
          type: "pragma.execution",
          id: "execution-memory-extraction-failed",
          canonicalEventId: "canonical-memory-extraction-failed",
        },
        subjectRefs: [{ type: "pragma.expert", id: "7k2m9q4v8np6r3dt" }],
        correlationId: "execution-memory-extraction-failed",
        occurredAt: now.toISOString(),
        visibility: { mode: "host-private" },
        sensitivity: "internal",
        bindings: [],
        attribution: {
          rootRef: { type: "pragma.expert", id: "7k2m9q4v8np6r3dt" },
          producerRefs: [{ type: "pragma.expert", id: "7k2m9q4v8np6r3dt" }],
        },
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [],
        },
        payload: { outcome: "succeeded" },
      }),
    ]);
    const due = new Date(now.getTime() + 6 * 60 * 60 * 1_000);
    const job = await plane.episodicStore.claimDueJob(due);
    if (job === undefined) throw new Error("Expected an episodic extraction job.");
    await plane.episodicStore.fail({
      job,
      diagnostic: {
        schemaVersion: "pragma.memory-extraction-failure/v1",
        code: "memory_curator_failed",
        message: "Memory Curator failed.",
        phase: "curator_run",
        failedAt: due.toISOString(),
      },
      now: due,
      retry: "configuration",
    });
    await plane.policies.updateGlobal({
      expectedRevision: 1,
      policy: {
        enabled: "disabled",
        capture: "disabled",
        recall: "disabled",
        learning: "disabled",
      },
    });

    plane.start();
    await vi.waitFor(
      async () => {
        await expect(plane.getStatus()).resolves.toMatchObject({
          state: "degraded",
          lastError: { code: "memory_curator_failed" },
          modules: expect.arrayContaining([
            expect.objectContaining({
              moduleId: "pragma.memory.episodic",
              status: "degraded",
              lastErrorCode: "memory_curator_failed",
              work: expect.objectContaining({ needsAttention: 1 }),
            }),
          ]),
        });
      },
      { timeout: backgroundSettlementTimeoutMs },
    );
    await vi.waitFor(() => {
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "error",
          event: "desktop.memory_extraction_needs_attention",
          attributes: expect.objectContaining({
            moduleId: "pragma.memory.episodic",
            code: "memory_curator_failed",
            needsAttention: 1,
          }),
        }),
      );
    });

    // Keep the next background iteration open: health must follow the store,
    // without waiting for the retry or the iteration to finish.
    let releaseTick!: () => void;
    let enteredTick!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredTick = resolve;
    });
    onTick = async () => {
      enteredTick();
      await blocked;
    };
    plane.wakePipeline();
    await entered;
    try {
      await plane.manageMemoryJob({
        module: "episodic",
        action: "retry",
        id: job.id,
        expectedRevision: job.revision + 1,
      });
      const pending = await plane.getStatus();
      expect(pending.state).toBe("running");
      expect(pending.lastError).toBeUndefined();
      expect(pending.modules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            moduleId: "pragma.memory.episodic",
            status: "healthy",
            work: expect.objectContaining({ pending: 1, needsAttention: 0 }),
          }),
        ]),
      );
      const retried = await plane.episodicStore.claimDueJob(due);
      expect(retried).toBeDefined();
      const running = await plane.getStatus();
      expect(running.state).toBe("running");
      expect(running.lastError).toBeUndefined();
      expect(running.modules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            moduleId: "pragma.memory.episodic",
            work: expect.objectContaining({ running: 1, needsAttention: 0 }),
          }),
        ]),
      );
      await plane.episodicStore.fail({
        job: retried!,
        diagnostic: {
          schemaVersion: "pragma.memory-extraction-failure/v1",
          code: "memory_curator_timeout",
          message: "Retry failed.",
          phase: "curator_run",
          failedAt: due.toISOString(),
        },
        now: due,
        retry: "configuration",
      });
      await expect(plane.getStatus()).resolves.toMatchObject({
        state: "degraded",
        lastError: { code: "memory_curator_timeout" },
      });
    } finally {
      releaseTick();
      await plane.stop();
    }
  });

  it("retains an independent pipeline failure until a successful background iteration", async () => {
    let releaseTick!: () => void;
    let enteredTick!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseTick = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredTick = resolve;
    });
    const onTick = vi.fn(async () => {
      enteredTick();
      await blocked;
    });
    onTick.mockRejectedValueOnce(new Error("Pipeline unavailable"));
    const plane = await createDesktopMemoryPlane({
      pragmaHome: await temporaryRoot("pragma-memory-pipeline-failure-"),
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
      onTick,
    });
    try {
      plane.start();
      await vi.waitFor(async () => {
        expect((await plane.getStatus()).lastError?.code).toBe("memory_pipeline_iteration_failed");
      });
      plane.wakePipeline();
      await entered;
      const status = await plane.getStatus();
      expect(status.modules.every((module) => module.status === "healthy")).toBe(true);
      expect(status).toMatchObject({
        state: "degraded",
        lastError: { code: "memory_pipeline_iteration_failed" },
      });
      releaseTick();
      await vi.waitFor(async () => {
        const recovered = await plane.getStatus();
        expect(recovered.state).toBe("running");
        expect(recovered.lastError).toBeUndefined();
      });
    } finally {
      releaseTick();
      await plane.stop();
    }
  });

  it.each(["both", "episodic", "semantic"] as const)(
    "counts %s conversation failures once and removes the logical task from both views",
    async (failedType) => {
      const pragmaHome = await temporaryRoot("pragma-memory-logical-attention-");
      const plane = await createDesktopMemoryPlane({
        pragmaHome,
        logger: createPragmaLogger(undefined, { component: "test.logical-attention" }),
      });
      try {
        const now = new Date();
        const evidence = [
          MemoryEvidenceEnvelopeSchema.parse({
            schemaVersion: "pragma.memory-evidence/v1",
            messageId: "terminal-memory-extraction-failed",
            topic: "execution.execution.terminal",
            schemaRef: "pragma.memory.execution-terminal/v2",
            sourceRef: {
              type: "pragma.execution",
              id: "execution-memory-extraction-failed",
              canonicalEventId: "canonical-memory-extraction-failed",
            },
            subjectRefs: [{ type: "pragma.expert", id: "7k2m9q4v8np6r3dt" }],
            correlationId: "execution-memory-extraction-failed",
            occurredAt: now.toISOString(),
            visibility: { mode: "host-private" },
            sensitivity: "internal",
            bindings: [],
            attribution: {
              rootRef: { type: "pragma.expert", id: "7k2m9q4v8np6r3dt" },
              producerRefs: [{ type: "pragma.expert", id: "7k2m9q4v8np6r3dt" }],
            },
            policySnapshot: {
              capture: true,
              recall: true,
              learning: "local-candidates",
              appliedRevisions: [],
            },
            payload: { outcome: "succeeded" },
          }),
        ];

        await plane.episodicStore.ingest(evidence);
        await plane.semanticStore.ingest(evidence);
        const due = new Date(now.getTime() + 6 * 60 * 60 * 1_000);
        const failure = {
          diagnostic: {
            schemaVersion: "pragma.memory-extraction-failure/v1" as const,
            code: "memory_curator_failed",
            message: "Memory Curator failed.",
            phase: "curator_run" as const,
            failedAt: due.toISOString(),
          },
          now: due,
          retry: "configuration" as const,
        };
        if (failedType === "both" || failedType === "episodic") {
          const job = await plane.episodicStore.claimDueJob(due);
          expect(job).toBeDefined();
          await plane.episodicStore.fail({ ...failure, job: job! });
        }
        if (failedType === "both" || failedType === "semantic") {
          const job = await plane.semanticStore.claimDueJob(due);
          expect(job).toBeDefined();
          await plane.semanticStore.fail({ ...failure, job: job! });
        }
        const attention = await plane.conversationExtractionJobs.listJobsPage({
          statuses: ["attention"],
          sortKeyPrefix: "conversation",
          limit: 1,
        });
        expect(attention.total).toBe(1);
        expect((await plane.getStatus()).extractionNeedsAttention).toBe(attention.total);
        const task = attention.jobs[0]!;
        const retireJobs = vi.fn(async () => undefined);
        await plane.setConversationExtractor(undefined, { retireJobs });
        await plane.manageMemoryJob({
          module: "conversation",
          action: "delete",
          id: task.job.id,
          expectedRevision: task.job.revision,
        });
        expect(retireJobs).toHaveBeenCalledOnce();
        expect((await plane.getStatus()).extractionNeedsAttention).toBe(0);
        expect(
          (
            await plane.conversationExtractionJobs.listJobsPage({
              statuses: ["attention"],
              sortKeyPrefix: "conversation",
              limit: 1,
            })
          ).total,
        ).toBe(0);
      } finally {
        await plane.stop();
      }
    },
  );

  it("counts independent learning tasks using full lane totals rather than page lengths", async () => {
    const pragmaHome = await temporaryRoot("pragma-memory-learning-attention-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "test.learning-attention" }),
    });
    try {
      vi.spyOn(plane.knowledgeLearningStore, "listJobsPage").mockResolvedValue({
        total: 12,
        jobs: [],
      });
      vi.spyOn(plane.skillLearningStore, "listJobsPage").mockResolvedValue({
        total: 3,
        jobs: [],
      });
      expect((await plane.getStatus()).extractionNeedsAttention).toBe(15);
    } finally {
      await plane.stop();
    }
  });

  it("does not downgrade an unavailable module when extraction also needs attention", () => {
    expect(resolveMemoryModuleHealthStatus("unavailable", 1)).toBe("unavailable");
    expect(resolveMemoryModuleHealthStatus("degraded", 1)).toBe("degraded");
    expect(resolveMemoryModuleHealthStatus("healthy", 1)).toBe("degraded");
  });

  it("registers stable local User and Project subjects without inventing a Repository", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-subjects-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
    });

    await plane.registerMemoryExecutionContext({
      executionId: "execution-a",
      missionId: "mission-a",
      projectId: "project-a",
    });
    const first = await plane.semanticStore.getSubjectContext("execution-a");
    await plane.registerMemoryExecutionContext({
      executionId: "execution-b",
      missionId: "mission-a",
      projectId: "project-a",
    });
    const second = await plane.semanticStore.getSubjectContext("execution-b");

    const firstUser = first?.subjectRefs.find((ref) => ref.type === "pragma.user");
    const secondUser = second?.subjectRefs.find((ref) => ref.type === "pragma.user");
    expect(firstUser?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondUser).toEqual(firstUser);
    expect(first?.subjectRefs).toContainEqual({ type: "pragma.project", id: "project-a" });
    expect(first?.subjectRefs.some((ref) => ref.type === "pragma.repository")).toBe(false);
    await expect(plane.activity.getExecutionContext("execution-a")).resolves.toMatchObject({
      executionId: "execution-a",
      principalRefs: expect.arrayContaining([
        firstUser,
        { type: "pragma.project", id: "project-a" },
      ]),
    });
    await plane.stop();
  });

  it("checks a personal data scope against the combined Team and Expert policy", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-context-view-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
    });
    await plane.policies.updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    const input = {
      rootRef: { type: "pragma.expert" as const, id: "1xddvess309a6gme" },
      expertRef: { type: "pragma.expert" as const, id: "1xddvess309a6gme" },
      projectId: "pragma",
      policyScope: {
        rootRef: { type: "pragma.expert-team" as const, id: "vyv9pwwzaksth2dd" },
        producerRefs: [{ type: "pragma.expert" as const, id: "1xddvess309a6gme" }],
      },
    };

    await expect(plane.getContextStoreViewStatus(input)).resolves.toBe("empty");
    const teamRef = { type: "pragma.expert-team" as const, id: "vyv9pwwzaksth2dd" };
    const team = await plane.policies.getOverride(teamRef);
    await plane.policies.updateOverride({
      targetRef: teamRef,
      expectedRevision: team.revision,
      policy: { capture: "inherit", recall: "disabled", learning: "inherit" },
    });
    await expect(plane.getContextStoreViewStatus(input)).resolves.toBe("recall_disabled");
    await expect(plane.createContextStoreView(input)).rejects.toMatchObject({
      code: "memory_recall_disabled",
    });
    await plane.stop();
  });
});

describe("Desktop Memory recall scope", () => {
  it("intersects the root asset and current Expert policies", async () => {
    const resolveAt = vi.fn(async () => ({
      capture: true,
      recall: true,
      learning: "local-candidates" as const,
      appliedRevisions: [],
    }));
    const now = new Date("2026-08-01T00:00:00.000Z");

    await expect(
      resolveMemoryRecallScope(
        { resolveAt },
        {
          source: { type: "pragma.expert-team", id: "team-a" },
          attributes: { [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a" },
        },
        now,
      ),
    ).resolves.toEqual({
      rootRef: { type: "pragma.expert-team", id: "team-a" },
      expertRef: { type: "pragma.expert", id: "expert-a" },
    });
    expect(resolveAt).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert-team", id: "team-a" },
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
      occurredAt: now.toISOString(),
    });
  });

  it("fails closed for missing identity or disabled recall", async () => {
    const resolveAt = vi.fn(async () => ({
      capture: true,
      recall: false,
      learning: "local-candidates" as const,
      appliedRevisions: [],
    }));
    await expect(resolveMemoryRecallScope({ resolveAt }, undefined)).resolves.toBeUndefined();
    expect(resolveAt).not.toHaveBeenCalled();
    await expect(
      resolveMemoryRecallScope(
        { resolveAt },
        {
          source: { type: "pragma.flow", id: "flow-a" },
          attributes: { [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a" },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves an enabled Flow to its root Flow and current Expert", async () => {
    const resolveAt = vi.fn(async () => ({
      capture: true,
      recall: true,
      learning: "local-candidates" as const,
      appliedRevisions: [],
    }));

    await expect(
      resolveMemoryRecallScope(
        { resolveAt },
        {
          source: { type: "pragma.flow", id: "flow-a" },
          attributes: { [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a" },
        },
      ),
    ).resolves.toEqual({
      rootRef: { type: "pragma.flow", id: "flow-a" },
      expertRef: { type: "pragma.expert", id: "expert-a" },
    });
    expect(resolveAt).toHaveBeenCalledWith({
      rootRef: { type: "pragma.flow", id: "flow-a" },
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
      occurredAt: expect.any(String),
    });
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
