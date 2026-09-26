import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import type { MissionRunner } from "../missions/mission-runner.ts";
import type { MissionStore } from "../missions/mission-store.ts";
import { MissionStoreError } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createMemoryRevisionLearningPlanners } from "./memory-revision-learning-planners.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("cleans only registered orphan planning Missions and replays a missing-Mission marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-plan-"));
  roots.push(root);
  const registry = join(root, "state", "memory-revision-planning");
  await mkdir(registry, { recursive: true });
  const existing = randomUUID();
  const alreadyDeleted = randomUUID();
  await Promise.all([
    writeFile(join(registry, existing), ""),
    writeFile(join(registry, alreadyDeleted), ""),
    writeFile(join(registry, "unrelated-file"), ""),
  ]);
  const deleteMission = vi.fn(async (id: string) => {
    if (id === alreadyDeleted) throw new MissionStoreError("mission_not_found", "Already deleted");
  });
  const planners = createMemoryRevisionLearningPlanners({
    pragmaHome: root,
    missions: {} as MissionStore,
    runner: { delete: deleteMission } as unknown as MissionRunner,
    project: {} as PragmaProjectStore,
  });
  expect(await planners.recoverOrphans()).toBe(2);
  expect(deleteMission).toHaveBeenCalledTimes(2);
  expect(await readdir(registry)).toEqual(["unrelated-file"]);
});

it("uses the Store Revision Agent for a read-only plan and removes its Mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-plan-"));
  roots.push(root);
  const missionId = randomUUID();
  const create = vi.fn(async () => ({ id: missionId }));
  const remove = vi.fn(async () => undefined);
  const planners = createMemoryRevisionLearningPlanners({
    pragmaHome: root,
    missions: {
      create,
      get: async () => ({ execution: { status: "succeeded" } }),
    } as unknown as MissionStore,
    runner: {
      run: async () => undefined,
      getChatPage: async () => ({ entries: [{ kind: "assistant", content: '{"action":"skip"}' }] }),
      delete: remove,
    } as unknown as MissionRunner,
    project: {
      ensurePublished: async () => ({ projectId: "project", revision: 1 }),
    } as unknown as PragmaProjectStore,
  });
  expect(
    await planners.knowledge.plan({
      rootRef: { type: "pragma.expert", id: "expert-a" },
      expertRef: "expert:expert-a",
      sourceDigest: "a".repeat(64),
      sources: [],
      signal: new AbortController().signal,
    }),
  ).toEqual({ action: "skip" });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      executor: expect.objectContaining({ ref: "expert:0000000000st0rev" }),
      origin: { type: "system-memory", jobId: `knowledge-plan:${"a".repeat(64)}` },
    }),
  );
  expect(remove).toHaveBeenCalledWith(missionId);
  expect(await readdir(join(root, "state", "memory-revision-planning"))).toEqual([]);
});

it("preserves Runtime failure codes so configuration jobs can be woken", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-plan-"));
  roots.push(root);
  const planners = createMemoryRevisionLearningPlanners({
    pragmaHome: root,
    missions: {
      create: async () => ({ id: randomUUID() }),
      get: async () => ({ execution: { status: "failed", error: "Runtime failed" } }),
    } as unknown as MissionStore,
    runner: {
      run: async () => undefined,
      getTerminalRuntimeFailure: async () => ({
        code: "runtime_unavailable",
        message: "No Runtime is configured.",
        retryable: false,
        failedAt: new Date().toISOString(),
      }),
      delete: async () => undefined,
    } as unknown as MissionRunner,
    project: {
      ensurePublished: async () => ({ projectId: "project", revision: 1 }),
    } as unknown as PragmaProjectStore,
  });
  await expect(
    planners.knowledge.plan({
      rootRef: { type: "pragma.expert", id: "expert-a" },
      expertRef: "expert:expert-a",
      sourceDigest: "b".repeat(64),
      sources: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: "runtime_unavailable", retryable: false });
});
