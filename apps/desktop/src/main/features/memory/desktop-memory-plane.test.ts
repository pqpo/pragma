import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLoggerProvider,
  createPragmaLogger,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  PragmaPaths,
} from "@pragma/core";
import { MemoryEvidenceEnvelopeSchema, type PragmaLogRecord } from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopMemoryPlane,
  resolveDesktopMemoryRecallScope,
  resolveMemoryModuleHealthStatus,
} from "./desktop-memory-plane.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("DesktopMemoryPlane", () => {
  it("is an always-available host service whose background loop starts explicitly", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
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
    await vi.waitFor(async () => {
      await expect(plane.getStatus()).resolves.toMatchObject({
        state: "degraded",
        delivery: { pending: 0, quarantined: 1 },
        lastError: { code: "canonical_event_handoff_quarantined" },
      });
    });
    await plane.stop();
  });

  it("reports extraction jobs that need attention as a degraded user-visible status", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-extraction-failed-");
    const logs: PragmaLogRecord[] = [];
    const loggerProvider = createLoggerProvider({
      handler: { write: (record) => logs.push(record) },
      minimumLevel: "debug",
    });
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(loggerProvider, { component: "desktop.memory-test" }),
      pollIntervalMs: 10,
    });
    const now = new Date("2026-08-04T00:00:00.000Z");
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

    plane.start();
    await vi.waitFor(async () => {
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
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "desktop.memory_pipeline_degraded",
        attributes: expect.objectContaining({ code: "memory_curator_failed" }),
      }),
    );
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

    await plane.wakeMemoryJobs();
    await vi.waitFor(async () => {
      await expect(plane.getStatus()).resolves.toMatchObject({
        state: "running",
        modules: expect.arrayContaining([
          expect.objectContaining({
            moduleId: "pragma.memory.episodic",
            status: "healthy",
            work: expect.objectContaining({ pending: 1, needsAttention: 0 }),
          }),
        ]),
      });
    });
    await plane.stop();
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
      resolveDesktopMemoryRecallScope(
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
    await expect(
      resolveDesktopMemoryRecallScope({ resolveAt }, undefined),
    ).resolves.toBeUndefined();
    expect(resolveAt).not.toHaveBeenCalled();
    await expect(
      resolveDesktopMemoryRecallScope(
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
      resolveDesktopMemoryRecallScope(
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
