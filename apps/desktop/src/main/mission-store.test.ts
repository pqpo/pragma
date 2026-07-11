import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExpertDefinition } from "../shared/desktop-api.ts";
import { createMissionStore } from "./mission-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("mission store", () => {
  it("persists a mission and an immutable executor snapshot", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const expert = expertFixture();

    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Design the Missions experience\nwith a second line.",
      expert,
    });

    expect(created.title).toBe("Design the Missions experience");
    expect(created.executor).toMatchObject({ kind: "expert", id: expert.id, revision: 1 });
    await expect(store.get(created.id)).resolves.toEqual(created);
    await expect(store.getExecutor(created.id)).resolves.toEqual(expert);
    await expect(store.list()).resolves.toEqual([created]);
    expect(await readFile(join(root, "missions", created.id, "executor.json"), "utf8")).toContain(
      '"revision": 1',
    );
  });

  it("marks a mission complete and reopens it", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Review the desktop shell",
      expert: expertFixture(),
    });

    const completed = await store.markComplete(created.id);
    expect(completed.lifecycleStatus).toBe("completed");
    expect(completed.completedAt).toBeDefined();

    const reopened = await store.reopen(created.id);
    expect(reopened.lifecycleStatus).toBe("active");
    expect(reopened.completedAt).toBeUndefined();
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

function expertFixture(): ExpertDefinition {
  return {
    schemaVersion: "pragma.expert/v2",
    id: "product_designer",
    name: "Product Designer",
    description: "Designs product experiences.",
    tags: ["design"],
    version: "0.1.0",
    scope: "Product experience design.",
    model: null,
    capabilities: [],
    toolApprovals: {},
    plugins: [],
    contextStoreMounts: [],
    revision: 1,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}
