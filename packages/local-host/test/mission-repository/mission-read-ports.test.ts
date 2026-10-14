import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPragmaLogger,
  encodePragmaPathSegment,
  PragmaPaths,
  type RuntimeResolver,
} from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationError } from "@pragma/shared/integration";

import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createLocalHostNodeApplication } from "../../src/node-application.ts";
import { createLocalHostMissionBoardBindings } from "../../src/mission-board.ts";
import { createLocalHostMissionReadPorts } from "../../src/missions/read-ports.ts";
import { createMissionDeletionService } from "../../src/missions/deletion.ts";

async function diagnosticFixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-mission-diagnostic-"));
  roots.push(home);
  const missionsPath = join(home, "data", "missions");
  const repository = createMissionStore({ missionsPath });
  const controller = createMissionControllerStore({
    missionsPath,
    missionPath: repository.storagePath,
  });
  const missionId = "11111111-1111-4111-8111-111111111111";
  const guard = await controller.claim({ missionId, claimId: missionId, leaseMs: 60_000 });
  await controller.write({
    missionId,
    guard,
    operation: async ({ appendEvent }) => {
      await appendEvent("mission.created", {});
    },
  });
  const ports = createLocalHostMissionReadPorts({ pragmaHome: home, repository, controller });
  return { home, missionsPath, repository, controller, missionId, guard, ports };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Shared Mission read ports in the Node application", () => {
  it("isolates a deletion record owner mismatch without hiding healthy Missions", async () => {
    const target = await diagnosticFixture();
    const badId = "4b4f2993-4f39-4915-adc4-a052163d4e28";
    const paths = new PragmaPaths({ pragmaHome: target.home });
    await target.controller.claim({ missionId: badId, claimId: badId, leaseMs: 60_000 });
    const deletion = createMissionDeletionService({
      paths,
      logger: createPragmaLogger(undefined, { component: "test" }),
      ports: {
        usage: async () => {},
        memory: async () => {},
        drafts: async () => {},
        claims: async () => {},
        settlement: async () => {},
      },
    });
    const record = await deletion.prepare({ missionId: badId, executionIds: [], payload: {} });
    await writeFile(
      paths.missionDeletion(badId),
      JSON.stringify({ ...record, missionId: target.missionId }),
    );
    await expect(target.ports.missions.listDiagnostics()).resolves.toMatchObject({
      items: [expect.objectContaining({ missionId: target.missionId })],
      diagnostics: [
        {
          code: "STORAGE_CORRUPTED",
          details: { missionId: badId, stage: "deletion-record.read", reason: "owner_mismatch" },
        },
      ],
    });
    expect(JSON.parse(await readFile(paths.missionDeletion(badId), "utf8")).missionId).toBe(
      target.missionId,
    );
  });

  it.each(["repository", "controller"])(
    "enriches structured errors from %s and preserves precise details",
    async (layer) => {
      const target = await diagnosticFixture();
      const fail = vi.fn(async () => {
        throw createIntegrationError({
          code: "STORAGE_CORRUPTED",
          category: "protocol",
          message: "Invalid transaction owner.",
        });
      });
      const ports = createLocalHostMissionReadPorts({
        pragmaHome: target.home,
        repository:
          layer === "repository" ? { ...target.repository, get: fail } : target.repository,
        controller:
          layer === "controller" ? { ...target.controller, readSnapshot: fail } : target.controller,
      });
      const stage = layer === "repository" ? "repository.read" : "controller.read";
      await expect(ports.missions.listDiagnostics()).resolves.toMatchObject({
        items: [],
        diagnostics: [
          {
            code: "STORAGE_CORRUPTED",
            details: { missionId: target.missionId, stage, file: expect.any(String) },
          },
        ],
      });
      const details = {
        missionId: target.missionId,
        stage: "transaction.read",
        file: "local-host/.event-transaction.json",
        reason: "owner_mismatch",
      };
      fail.mockImplementation(async () => {
        throw createIntegrationError({
          code: "STORAGE_CORRUPTED",
          category: "protocol",
          message: "Invalid transaction owner.",
          details,
        });
      });
      await expect(ports.missions.listDiagnostics()).resolves.toMatchObject({
        diagnostics: [{ details }],
      });
    },
  );

  it("returns explicit partial diagnostics for journal-only owners without changing their evidence", async () => {
    const target = await diagnosticFixture();
    const orphanId = "4b4f2993-4f39-4915-adc4-a052163d4e28";
    const directory = join(target.missionsPath, encodePragmaPathSegment(orphanId), "local-host");
    await mkdir(directory, { recursive: true });
    const journal = join(directory, ".semantic-write-transaction.json");
    const evidence = "original unreadable transaction evidence";
    await writeFile(journal, evidence);
    await expect(target.ports.missions.listDiagnostics()).resolves.toMatchObject({
      items: [expect.objectContaining({ missionId: target.missionId })],
      diagnostics: [
        {
          code: "STORAGE_CORRUPTED",
          details: {
            missionId: orphanId,
            stage: "owner.inspect",
            file: "local-host/aggregate.json",
            reason: "journal_without_aggregate",
          },
        },
      ],
    });
    await expect(target.ports.missions.list()).rejects.toMatchObject({
      details: { availableMissionIds: [target.missionId] },
    });
    await expect(
      target.controller.claim({ missionId: orphanId, claimId: orphanId, leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "STORAGE_CORRUPTED" });
    expect(await readFile(journal, "utf8")).toBe(evidence);
    await expect(stat(join(directory, "aggregate.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const defaultController = createMissionControllerStore({ missionsPath: target.missionsPath });
    await expect(
      defaultController.claim({ missionId: orphanId, claimId: orphanId, leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "STORAGE_CORRUPTED" });
    await expect(stat(join(target.missionsPath, orphanId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("distinguishes deletion records from storage corruption without cleaning residual data", async () => {
    const target = await diagnosticFixture();
    const deletion = createMissionDeletionService({
      paths: new PragmaPaths({ pragmaHome: target.home }),
      logger: createPragmaLogger(undefined, { component: "test" }),
      ports: {
        usage: async () => {},
        memory: async () => {},
        drafts: async () => {},
        claims: async () => {},
        settlement: async () => {},
      },
    });
    await deletion.prepare({ missionId: target.missionId, executionIds: [], payload: {} });
    await expect(target.ports.missions.listDiagnostics()).resolves.toMatchObject({
      items: [],
      diagnostics: [{ code: "MISSION_NOT_FOUND", details: { reason: "deletion_prepared" } }],
    });
    await deletion.commit(target.missionId);
    await expect(target.ports.missions.listDiagnostics()).resolves.toMatchObject({
      items: [],
      diagnostics: [{ code: "MISSION_NOT_FOUND", details: { reason: "deletion_committed" } }],
    });
    expect(
      (await target.controller.readSnapshot({ missionId: target.missionId })).events,
    ).toHaveLength(1);
  });

  it("reports a pending transaction and leaves replay to the fenced mutation path", async () => {
    const target = await diagnosticFixture();
    await expect(
      target.controller.coordinateSemanticWrite({
        missionId: target.missionId,
        guard: target.guard,
        operation: { name: "mission.options.update", input: {} },
        eventType: "mission.options.updated",
        eventData: {},
        apply: async () => {
          throw new Error("crash");
        },
      }),
    ).rejects.toThrow("pending durable replay");
    const journal = join(
      target.repository.storagePath!(target.missionId),
      "local-host",
      ".semantic-write-transaction.json",
    );
    const original = await readFile(journal, "utf8");
    await expect(target.ports.missions.listDiagnostics()).resolves.toMatchObject({
      items: [expect.objectContaining({ missionId: target.missionId })],
      diagnostics: [],
      warnings: [{ code: "MISSION_TRANSACTION_PENDING", details: { missionId: target.missionId } }],
    });
    expect(await readFile(journal, "utf8")).toBe(original);
    const replay = vi.fn(async () => {});
    await target.controller.recoverSemanticWrite({
      missionId: target.missionId,
      guard: target.guard,
      replay,
    });
    expect(replay).toHaveBeenCalledOnce();
    await expect(target.ports.missions.listDiagnostics()).resolves.toMatchObject({
      diagnostics: [],
      warnings: [],
    });
  });

  it("keeps malformed aggregates unavailable and propagates unexpected errors", async () => {
    const target = await diagnosticFixture();
    const unexpected = new Error("unexpected repository bug");
    const failing = createLocalHostMissionReadPorts({
      pragmaHome: target.home,
      repository: {
        ...target.repository,
        get: async () => {
          throw unexpected;
        },
      },
      controller: target.controller,
    });
    await expect(failing.missions.listDiagnostics()).rejects.toBe(unexpected);
    const aggregate = join(
      target.repository.storagePath!(target.missionId),
      "local-host",
      "aggregate.json",
    );
    await writeFile(aggregate, "malformed aggregate");
    await expect(target.ports.missions.listDiagnostics()).resolves.toMatchObject({
      items: [],
      diagnostics: [
        {
          code: "STORAGE_CORRUPTED",
          details: {
            missionId: target.missionId,
            stage: "controller.read",
            reason: "invalid_data",
          },
        },
      ],
    });
    expect(await readFile(aggregate, "utf8")).toBe("malformed aggregate");
  });

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
      client: { surface: "desktop", version: "test", instanceId: "read-ports-test" },
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
