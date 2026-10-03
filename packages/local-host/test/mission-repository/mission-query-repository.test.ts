import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalHostMissionController } from "../../src/missions/controller/composition.ts";
import {
  createMissionStore,
  MissionStoreError,
} from "../../src/missions/repository/mission-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-mission-query-repository-"));
  roots.push(root);
  const missionsPath = join(root, "missions");
  const repository = createMissionStore({ missionsPath });
  const composition = createLocalHostMissionController({
    missionsPath,
    missionPath: repository.storagePath,
    readMission: async (id) => {
      try {
        return await repository.get(id);
      } catch (error) {
        if (error instanceof MissionStoreError && error.code === "mission_not_found")
          return undefined;
        throw error;
      }
    },
  });
  const mission = await repository.create({
    workspace: { path: join(root, "workspace"), basename: "workspace" },
    goal: "Read a persisted Desktop envelope without invented controller facts",
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref: "expert:1xddvess309a6gme", name: "Writer" },
  });
  return { repository, mission, ...composition };
}

describe("Mission query repository authority", () => {
  it("reads real envelope summary and empty events without synthesizing execution results", async () => {
    const { repository, mission, query, controller } = await fixture();
    await expect(
      query.queryMission({ missionId: mission.id, view: "summary", limit: 20 }),
    ).resolves.toMatchObject({
      missionId: mission.id,
      status: "queued",
      lifecycleStatus: mission.lifecycleStatus,
      executor: { kind: "expert", id: "1xddvess309a6gme" },
      workspace: { canonicalPath: mission.workspace.path },
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      eventSequence: 0,
    });
    await expect(
      query.queryMission({ missionId: mission.id, view: "events", limit: 20 }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      query.queryMission({ missionId: mission.id, view: "result", limit: 20 }),
    ).resolves.toMatchObject({ status: "queued", available: false });
    const executionId = "22222222-2222-4222-8222-222222222222";
    await repository.updateExecution(mission.id, {
      id: executionId,
      inputMessageId: mission.initialMessageId,
      status: "succeeded",
      startedAt: mission.createdAt,
      finishedAt: mission.updatedAt,
    });
    await expect(
      query.queryMission({ missionId: mission.id, view: "summary", limit: 20 }),
    ).resolves.toMatchObject({
      status: "succeeded",
      execution: { id: executionId, status: "succeeded" },
    });
    await expect(
      query.queryMission({ missionId: mission.id, view: "result", limit: 20 }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_UNAVAILABLE",
      details: { reason: "mission_execution_facts_unavailable" },
    });
    expect((await controller.readSnapshot({ missionId: mission.id })).events).toEqual([]);
    const guard = await controller.claim({
      missionId: mission.id,
      claimId: "55555555-5555-4555-8555-555555555555",
      leaseMs: 10_000,
    });
    await controller.write({
      missionId: mission.id,
      guard,
      operation: async ({ appendEvent }) => {
        await appendEvent("run.accepted", {
          inputMessageId: "66666666-6666-4666-8666-666666666666",
        });
      },
    });
    await controller.release({ missionId: mission.id, guard });
    const queued = await query.queryMission({ missionId: mission.id, view: "summary", limit: 20 });
    expect(queued).toMatchObject({ status: "queued" });
    expect(queued).not.toHaveProperty("execution");
    await expect(
      query.queryMission({ missionId: mission.id, view: "result", limit: 20 }),
    ).resolves.toMatchObject({ status: "queued", available: false });
  });

  it("keeps controller-only history readable without materializing an envelope", async () => {
    const { repository, query, controller } = await fixture();
    const missionId = "33333333-3333-4333-8333-333333333333";
    const guard = await controller.claim({
      missionId,
      claimId: "44444444-4444-4444-8444-444444444444",
      leaseMs: 10_000,
    });
    await controller.write({
      missionId,
      guard,
      operation: async ({ appendEvent }) => {
        await appendEvent("mission.created", {
          executor: { kind: "expert", id: "1xddvess309a6gme" },
          workspace: "/tmp/controller-only",
        });
        await appendEvent("run.started", { executionId: missionId });
        await appendEvent("run.succeeded", {
          executionId: missionId,
          result: { answer: "original result" },
        });
      },
    });
    await controller.release({ missionId, guard });
    await expect(
      query.queryMission({ missionId, view: "summary", limit: 20 }),
    ).resolves.toMatchObject({
      status: "succeeded",
      workspace: { canonicalPath: "/tmp/controller-only" },
    });
    await expect(
      query.queryMission({ missionId, view: "result", limit: 20 }),
    ).resolves.toMatchObject({ available: true, result: { answer: "original result" } });
    await expect(repository.get(missionId)).rejects.toMatchObject({ code: "mission_not_found" });
    expect(
      (await controller.readSnapshot({ missionId })).events.map((event) => event.type),
    ).toEqual(["mission.created", "run.started", "run.succeeded"]);
  });

  it("rejects a future envelope version before any summary or event projection", async () => {
    const { repository, mission, query } = await fixture();
    const path = join(repository.storagePath!(mission.id), "mission.yaml");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("pragma.mission/v11", "pragma.mission/v999"),
    );
    for (const view of ["summary", "events"] as const) {
      await expect(
        query.queryMission({ missionId: mission.id, view, limit: 20 }),
      ).rejects.toMatchObject({ code: "unsupported_schema" });
    }
  });
});
