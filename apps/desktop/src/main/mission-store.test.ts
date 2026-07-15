import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PragmaExpertResource } from "@pragma/interpreter/ast";
import { createMissionStore } from "./mission-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("mission store", () => {
  it("persists a mission pinned to an immutable project revision", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const expert = expertFixture();

    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Design the Missions experience\nwith a second line.",
      project: { id: "studio", revision: 3 },
      executor: expert,
    });

    expect(created.title).toBe("Design the Missions experience");
    expect(created.executor).toMatchObject({
      kind: "expert",
      ref: "expert:product_designer@0.1.0",
    });
    expect(created.project).toEqual({ id: "studio", revision: 3 });
    await expect(store.get(created.id)).resolves.toEqual(created);
    await expect(store.list()).resolves.toEqual([created]);
    expect(await readFile(join(root, "missions", created.id, "mission.yaml"), "utf8")).toContain(
      "revision: 3",
    );
  });

  it("marks a mission complete and reopens it", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Review the desktop shell",
      project: { id: "studio", revision: 1 },
      executor: expertFixture(),
    });

    const completed = await store.markComplete(created.id);
    expect(completed.lifecycleStatus).toBe("completed");
    expect(completed.completedAt).toBeDefined();

    const reopened = await store.reopen(created.id);
    expect(reopened.lifecycleStatus).toBe("active");
    expect(reopened.completedAt).toBeUndefined();
  });

  it("does not let a stale observer overwrite a terminal execution status", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Run once",
      project: { id: "studio", revision: 1 },
      executor: expertFixture(),
    });
    const executionId = "00000000-0000-4000-8000-000000000001";
    const startedAt = "2026-07-15T00:00:00.000Z";
    await store.updateExecution(created.id, { id: executionId, status: "running", startedAt });
    await store.updateExecution(
      created.id,
      {
        id: executionId,
        status: "succeeded",
        startedAt,
        finishedAt: "2026-07-15T00:01:00.000Z",
      },
      { executionId, statuses: ["running", "waiting"] },
    );

    const stale = await store.updateExecution(
      created.id,
      { id: executionId, status: "waiting", startedAt },
      { executionId, statuses: ["running", "waiting"] },
    );

    expect(stale.execution?.status).toBe("succeeded");
    expect((await store.get(created.id)).execution?.status).toBe("succeeded");
  });

  it("reports a stable error for a missing mission", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    await expect(store.get("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "mission_not_found",
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pragma-missions-"));
  temporaryPaths.push(path);
  return path;
}

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v1",
    kind: "Expert",
    metadata: {
      id: "product_designer",
      name: "Product Designer",
      description: "Designs product experiences.",
      tags: ["design"],
      version: "0.1.0",
    },
    spec: {
      scope: "Product experience design.",
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
