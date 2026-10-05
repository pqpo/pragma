import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { RuntimeResolver } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createLocalHostNodeApplication } from "../../src/node-application.ts";

const roots: string[] = [];
const hosts: ReturnType<typeof createLocalHostNodeApplication>[] = [];
afterEach(async () => {
  // Explicit queries can admit bounded receipt recovery after the read returns.
  // The fixture owns its facade, just as production CLI does: settle that work
  // before removing the storage tree rather than racing its live aggregate locks.
  await Promise.all(hosts.splice(0).map(async (host) => await host.dispose?.()));
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-mission-live-path-"));
  roots.push(home);
  const missionsPath = join(home, "data", "missions");
  const store = createMissionStore({ missionsPath });
  const legacy = createMissionControllerStore({ missionsPath });
  const missionId = "11111111-1111-4111-8111-111111111111";
  const guard = await legacy.claim({
    missionId,
    claimId: "22222222-2222-4222-8222-222222222222",
    leaseMs: 60_000,
  });
  await legacy.write({
    missionId,
    guard,
    operation: async ({ appendEvent }) => {
      await appendEvent("mission.created", {
        executor: { kind: "expert", id: "1xddvess309a6gme" },
        workspace: home,
      });
      await appendEvent("run.started", { executionId: "33333333-3333-4333-8333-333333333333" });
      await appendEvent("run.succeeded", {
        executionId: "33333333-3333-4333-8333-333333333333",
        result: { original: true },
      });
    },
  });
  const dispatch = vi.fn(async () => {
    throw new Error("Reading must not dispatch a Runtime");
  });
  const runtimes: RuntimeResolver = {
    getDefaultRuntimeId: async () => "test",
    bind: dispatch,
    resolve: dispatch,
  };
  const host = createLocalHostNodeApplication({
    pragmaHome: home,
    runtimes,
    workspace: {
      stat: async () => ({ isDirectory: () => true }),
      access: async () => undefined,
      realpath: async (path) => path,
    },
    client: { surface: "cli", version: "test", instanceId: "44444444-4444-4444-8444-444444444444" },
  });
  hosts.push(host);
  return { home, missionsPath, store, legacy, missionId, guard, host, dispatch };
}

describe("Mission path migration and historical controller leases", () => {
  it("shares one authority with a historical controller that reacquires after path upgrade", async () => {
    const { missionsPath, store, legacy, missionId, guard, host } = await fixture();
    await legacy.release({ missionId, guard });
    await host.queryMission({ missionId, view: "summary", limit: 20 });
    const canonical = createMissionControllerStore({
      missionsPath,
      missionPath: store.storagePath,
    });
    const claimed = await canonical.claim({
      missionId,
      claimId: "66666666-6666-4666-8666-666666666666",
      leaseMs: 60_000,
    });
    await expect(
      legacy.claim({ missionId, claimId: "77777777-7777-4777-8777-777777777777", leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    expect((await legacy.readSnapshot({ missionId })).snapshot.lease?.claimId).toBe(
      claimed.claimId,
    );
    await canonical.release({ missionId, guard: claimed });
    const reacquired = await legacy.claim({
      missionId,
      claimId: "77777777-7777-4777-8777-777777777777",
      leaseMs: 60_000,
    });
    await expect(
      canonical.claim({ missionId, claimId: claimed.claimId, leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    await legacy.release({ missionId, guard: reacquired });
  });

  it("refuses Node reads and control while an old UUID-path controller is live, then preserves facts on migration", async () => {
    const { missionsPath, store, legacy, missionId, guard, host, dispatch } = await fixture();
    const original = await readFile(
      join(missionsPath, missionId, "local-host", "aggregate.json"),
      "utf8",
    );
    await expect(host.listMissions()).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    await expect(host.getMission(missionId)).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    await expect(
      host.queryMission({ missionId, view: "summary", limit: 20 }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    await expect(
      host.missionControl!.submit({
        missionId,
        requestId: "55555555-5555-4555-8555-555555555555",
        kind: "send",
        payload: { kind: "send", prompt: "Do not steal the old owner" },
      }),
    ).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    expect(
      await readFile(join(missionsPath, missionId, "local-host", "aggregate.json"), "utf8"),
    ).toBe(original);
    await expect(stat(store.storagePath!(missionId))).rejects.toMatchObject({ code: "ENOENT" });
    // A legacy callback already holds the aggregate lock. Refusal must finish
    // without waiting to re-enter that lock or acquiring metadata first.
    await legacy.write({
      missionId,
      guard,
      operation: async () => {
        await expect(store.get(missionId)).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
      },
    });
    await legacy.renew({ missionId, guard, leaseMs: 60_000 });
    await legacy.release({ missionId, guard });
    await expect(
      host.queryMission({ missionId, view: "result", limit: 20 }),
    ).resolves.toMatchObject({ available: true, result: { original: true } });
    await expect(stat(join(missionsPath, missionId))).rejects.toMatchObject({ code: "ENOENT" });
    const current = createMissionControllerStore({ missionsPath, missionPath: store.storagePath });
    expect((await current.readSnapshot({ missionId })).events.map((event) => event.type)).toEqual([
      "mission.created",
      "run.started",
      "run.succeeded",
    ]);
    await expect(
      host.queryMission({ missionId, view: "events", limit: 20 }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ type: "run.started" })]),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a prepared path journal and a full legacy envelope untouched until its lease is released", async () => {
    const { home, missionsPath, store, legacy, missionId, guard } = await fixture();
    await legacy.release({ missionId, guard });
    await expect(store.get(missionId)).rejects.toMatchObject({ code: "mission_not_found" });
    const mission = await store.create({
      id: missionId,
      workspace: { path: home, basename: basename(home) },
      goal: "Legacy Desktop envelope",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: "expert:1xddvess309a6gme", name: "Writer" },
    });
    const target = store.storagePath!(missionId);
    const source = join(missionsPath, missionId);
    await rename(target, source);
    const live = await legacy.claim({ missionId, claimId: guard.claimId, leaseMs: 60_000 });
    const journal = join(missionsPath, `.path-migration.${basename(target)}.json`);
    const contents = JSON.stringify({
      schemaVersion: "pragma.mission-path-migration/v1",
      missionId,
      legacy: source,
      target,
    });
    await writeFile(journal, contents);
    await expect(store.get(missionId)).rejects.toMatchObject({ code: "MISSION_LEASE_HELD" });
    expect(await readFile(journal, "utf8")).toBe(contents);
    expect(await readFile(join(source, "mission.yaml"), "utf8")).toContain(mission.goal);
    await legacy.release({ missionId, guard: live });
    await expect(store.get(missionId)).resolves.toMatchObject({
      id: missionId,
      goal: mission.goal,
    });
    await expect(readFile(journal, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
