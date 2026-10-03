import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeResolver } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostMissionReadPorts } from "../../src/missions/read-ports.ts";
import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createLocalHostNodeApplication } from "../../src/node-application.ts";
import { createLocalHostMissionBoardBindings } from "../../src/mission-board.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Shared Mission read ports in the injected Desktop facade", () => {
  it("reads controller-only history through get/list/query/watch/Board without inventing a full Mission", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-desktop-sparse-read-"));
    roots.push(home);
    const missionsPath = join(home, "data", "missions");
    const repository = createMissionStore({ missionsPath });
    const missionId = "11111111-1111-4111-8111-111111111111";
    const historical = createMissionControllerStore({ missionsPath });
    const guard = await historical.claim({
      missionId,
      claimId: "22222222-2222-4222-8222-222222222222",
      leaseMs: 60_000,
    });
    await historical.write({
      missionId,
      guard,
      operation: async ({ appendEvent }) => {
        await appendEvent("mission.created", {
          executor: { kind: "expert", id: "1xddvess309a6gme" },
          workspace: home,
        });
        await appendEvent("run.started", { executionId: missionId });
        await appendEvent("run.succeeded", { executionId: missionId, result: { original: true } });
      },
    });
    await historical.release({ missionId, guard });
    const controller = createMissionControllerStore({
      missionsPath,
      missionPath: repository.storagePath,
    });
    const read = createLocalHostMissionReadPorts({ pragmaHome: home, repository, controller });
    const runtimeAccess = vi.fn(async () => {
      throw new Error("Read ports must not dispatch a Runtime");
    });
    const runtimes: RuntimeResolver = {
      getDefaultRuntimeId: async () => "test",
      bind: runtimeAccess,
      resolve: runtimeAccess,
    };
    const host = createLocalHostNodeApplication({
      pragmaHome: home,
      runtimes,
      workspace: {
        stat: async () => ({ isDirectory: () => true }),
        access: async () => undefined,
        realpath: async (path) => path,
      },
      application: {
        catalog: {
          listProjects: async () => [],
          getProjectRevision: async () => undefined,
          listExecutors: async () => [],
        },
        missions: read.missions,
        board: read.board,
        watch: read.watch,
        assertMission: read.assertMission,
      },
    });
    expect(
      ((await host.getMission(missionId)) as Awaited<ReturnType<typeof controller.readSnapshot>>)
        .events,
    ).toHaveLength(3);
    await expect(host.listMissions()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ missionId, status: "succeeded" })]),
    );
    await expect(
      host.queryMission({ missionId, view: "summary", limit: 20 }),
    ).resolves.toMatchObject({ missionId, status: "succeeded" });
    await expect(
      host.queryMission({ missionId, view: "result", limit: 20 }),
    ).resolves.toMatchObject({ available: true, result: { original: true } });
    await expect(
      host.queryMission({ missionId, view: "events", limit: 20 }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ type: "run.started" })]),
    });
    await expect(
      host.watchMission!({ missionId, until: "terminal", onEvent: () => undefined }),
    ).resolves.toMatchObject({ observedStatus: "succeeded" });
    const bindings = await createLocalHostMissionBoardBindings({ pragmaHome: home, missionId });
    const board = bindings.find((binding) => binding.namespace === "mission-board")!.store;
    await board.addContext({
      id: "plan.md",
      content: "A real sparse Mission board",
      metadata: { description: "Plan", trigger: "manual", priority: "normal" },
    });
    await expect(host.listSharedBoard(missionId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "plan.md" })]),
    );
    await expect(host.readSharedBoard(missionId, "plan.md", 0, 4096)).resolves.toMatchObject({
      content: "A real sparse Mission board",
    });
    await expect(host.searchSharedBoard(missionId, "sparse", 10)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "plan.md" })]),
    );
    await expect(repository.get(missionId)).rejects.toMatchObject({ code: "mission_not_found" });
    await expect(repository.list()).resolves.toEqual([]);
    expect((await controller.readSnapshot({ missionId })).events).toHaveLength(3);
    expect(runtimeAccess).not.toHaveBeenCalled();
  });
});
