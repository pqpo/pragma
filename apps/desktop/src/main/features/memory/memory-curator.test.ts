import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEMORY_CURATOR_ID, MEMORY_CURATOR_REF } from "@pragma/memory";
import { MissionExecutorRefSchema } from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createMissionStore } from "../missions/mission-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Desktop Memory Curator", () => {
  it("crosses the real Mission persistence boundary with a valid hidden system identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-curator-"));
    roots.push(root);
    const missions = createMissionStore({ missionsPath: join(root, "missions") });

    expect(MissionExecutorRefSchema.parse(MEMORY_CURATOR_REF)).toBe(`expert:${MEMORY_CURATOR_ID}`);
    const mission = await missions.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Extract a durable episodic memory from supplied evidence.",
      title: "Memory extraction test",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: MEMORY_CURATOR_REF, name: "Memory Curator" },
      origin: { type: "system-memory", jobId: "episodic-test" },
    });

    await expect(missions.get(mission.id)).resolves.toMatchObject({
      executor: { ref: MEMORY_CURATOR_REF },
      origin: { type: "system-memory", jobId: "episodic-test" },
    });
    await expect(missions.list()).resolves.toEqual([]);
  });
});
