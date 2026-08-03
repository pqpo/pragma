import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPragmaLogger, EXECUTION_CURRENT_EXPERT_ID_ATTR, PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopMemoryPlane,
  resolveDesktopMemoryRecallScope,
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

  it("registers stable local User and Project subjects without inventing a Repository", async () => {
    const pragmaHome = await temporaryRoot("pragma-desktop-memory-subjects-");
    const plane = await createDesktopMemoryPlane({
      pragmaHome,
      logger: createPragmaLogger(undefined, { component: "desktop.memory-test" }),
    });

    await plane.registerSemanticExecutionContext({
      executionId: "execution-a",
      projectId: "project-a",
    });
    const first = await plane.semanticStore.getSubjectContext("execution-a");
    await plane.registerSemanticExecutionContext({
      executionId: "execution-b",
      projectId: "project-a",
    });
    const second = await plane.semanticStore.getSubjectContext("execution-b");

    const firstUser = first?.subjectRefs.find((ref) => ref.type === "pragma.user");
    const secondUser = second?.subjectRefs.find((ref) => ref.type === "pragma.user");
    expect(firstUser?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondUser).toEqual(firstUser);
    expect(first?.subjectRefs).toContainEqual({ type: "pragma.project", id: "project-a" });
    expect(first?.subjectRefs.some((ref) => ref.type === "pragma.repository")).toBe(false);
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
