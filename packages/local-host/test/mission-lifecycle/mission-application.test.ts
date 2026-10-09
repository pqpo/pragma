import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileExpertSessionStore,
  createStaticRuntimeResolver,
  PragmaPaths,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { createLocalHostApplication } from "../../src/index.ts";
import type { LocalHostMissionApplication } from "../../src/missions/application.ts";
import { describe, expect, it, vi } from "vitest";
import { createLocalHostMissionApplication } from "../../src/missions/application.ts";
import { createLocalHostMissionController } from "../../src/missions/controller/composition.ts";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createMissionSessionAssociationResolver } from "../../src/missions/session-association.ts";
import { MissionExecutionOwner } from "../../src/missions/execution-owner.ts";
import { createSqliteExecutionStore } from "../../src/execution/sqlite-execution-store.ts";
import { createLocalHostNodeMissionCompiler } from "../../src/node-mission-compiler.ts";
import { createLocalHostProjectCatalogFromHome } from "../../src/project-catalog.ts";
import { createLocalHostNodeExecutionResourcePorts } from "../../src/node-execution-resources.ts";
import { createLocalHostRunMemory } from "../../src/run-memory.ts";
import { findMissionPinnedBinding } from "../../src/missions/controller/pinned-binding.ts";
import type { LocalHostCoreActiveOwner } from "../../src/core-control-adapter.ts";
import {
  createPublishedProjectResources,
  writePublishedProjectFixture,
} from "../fixtures/published-project.ts";

// Real controller-only execution exercises the kernel independently of a
// Desktop envelope, product resource store or application override.
describe("shared Mission application composition", () => {
  it("retains a failed read-repair lease release for shared shutdown retry", async () => {
    const f = await createShutdownFixture();
    const missionId = randomUUID();
    try {
      const guard = await f.lifecycle.ownerScope.acquireForRecovery(missionId);
      vi.spyOn(f.lifecycle.controller, "release").mockRejectedValueOnce(
        new Error("read-repair release failed"),
      );
      await expect(f.lifecycle.ownerScope.release(missionId, guard)).rejects.toThrow(
        "read-repair release failed",
      );
      expect(f.lifecycle.ownerScope.currentGuard(missionId)).toBeUndefined();
      expect(f.lifecycle.ownerScope.ownedMissionIds()).toContain(missionId);
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease?.claimId,
      ).toBe(guard.claimId);
      await f.app.dispose();
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
      ).toBeUndefined();
      expect(f.lifecycle.ownerScope.ownedMissionIds()).toEqual([]);
      expect(f.closeResources).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });
  it("retries a failed consumer drain without closing resources or reopening acquisition", async () => {
    const f = await createShutdownFixture();
    const missionId = randomUUID();
    const startPolling = f.lifecycle.controller.startPolling.bind(f.lifecycle.controller);
    vi.spyOn(f.lifecycle.controller, "startPolling").mockImplementation((input) => {
      const poller = startPolling(input);
      return {
        ...poller,
        stop: async () => {
          await poller.stop();
          throw new Error("consumer drain failed");
        },
      };
    });
    try {
      const guard = await f.lifecycle.ownerScope.acquire(missionId);
      await expect(f.app.dispose()).rejects.toThrow("consumer drain failed");
      expect(f.closeResources).not.toHaveBeenCalled();
      expect(f.lifecycle.ownerScope.currentGuard(missionId)).toEqual(guard);
      await expect(f.lifecycle.ownerScope.acquire(randomUUID())).rejects.toThrow(
        "Mission owner scope is shutting down",
      );
      await f.app.dispose();
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
      ).toBeUndefined();
      expect(f.closeResources).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });
  it("drains an in-flight durable claim before releasing its final guard and closing resources", async () => {
    const f = await createShutdownFixture();
    const missionId = randomUUID();
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gated = new Promise<void>((resolve) => (finish = resolve));
    const claim = f.lifecycle.controller.claim.bind(f.lifecycle.controller);
    vi.spyOn(f.lifecycle.controller, "claim").mockImplementation(async (input) => {
      enter();
      await gated;
      return await claim(input);
    });
    try {
      const acquiring = f.lifecycle.ownerScope.acquire(missionId);
      const refused = expect(acquiring).rejects.toThrow("Mission owner scope is shutting down");
      await entered;
      const disposing = f.app.dispose();
      await expect(f.lifecycle.ownerScope.acquire(randomUUID())).rejects.toThrow(
        "Mission owner scope is shutting down",
      );
      expect(f.closeResources).not.toHaveBeenCalled();
      finish();
      await refused;
      await disposing;
      expect(f.lifecycle.ownerScope.ownedMissionIds()).toEqual([]);
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
      ).toBeUndefined();
      expect(f.closeResources).toHaveBeenCalledOnce();
    } finally {
      finish();
      await f.cleanup();
    }
  });
  it("drains admitted Runtime construction before stopping its exact owner", async () => {
    const f = await createShutdownFixture();
    const missionId = randomUUID();
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const gated = new Promise<void>((resolve) => (finish = resolve));
    const stopForDeletion = vi.fn(async () => f.markNativeStopped("admitted-native"));
    try {
      await f.lifecycle.ownerScope.acquire(missionId);
      const constructing = f.owners.admit(missionId, async () => {
        enter();
        await gated;
        f.owners.setControlOwner(
          missionId,
          {
            kind: "flow",
            execution: {
              executionId: "admitted-native",
              stopForDeletion,
              getState: async () => ({ status: "cancelled" }),
            },
          } as unknown as LocalHostCoreActiveOwner,
          "live",
        );
      });
      await entered;
      const disposing = f.app.dispose();
      expect(f.closeResources).not.toHaveBeenCalled();
      finish();
      await constructing;
      await disposing;
      expect(stopForDeletion).toHaveBeenCalledOnce();
      expect(f.owners.controlOwner(missionId)).toBeUndefined();
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
      ).toBeUndefined();
      expect(f.closeResources).toHaveBeenCalledOnce();
    } finally {
      finish();
      await f.cleanup();
    }
  });
  it("continues independent owner shutdown after a lease write failure and permits retry", async () => {
    const f = await createShutdownFixture();
    const first = randomUUID();
    const second = randomUUID();
    try {
      await f.lifecycle.ownerScope.acquire(first);
      await f.lifecycle.ownerScope.acquire(second);
      const release = vi.spyOn(f.lifecycle.controller, "release");
      release.mockRejectedValueOnce(new Error("controller lease write failed"));
      const attempt = f.app.dispose();
      expect(f.app.dispose()).toBe(attempt);
      await expect(attempt).rejects.toThrow("Mission application shutdown failed.");
      expect(release.mock.calls.map(([input]) => input.missionId)).toEqual([first, second]);
      expect(f.lifecycle.ownerScope.ownedMissionIds()).toEqual([first]);
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId: first })).snapshot.lease,
      ).toBeDefined();
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId: second })).snapshot.lease,
      ).toBeUndefined();
      expect(f.closeResources).toHaveBeenCalledTimes(1);
      await f.app.dispose();
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId: first })).snapshot.lease,
      ).toBeUndefined();
      const completed = f.app.dispose();
      expect(f.app.dispose()).toBe(completed);
      await completed;
    } finally {
      await f.cleanup();
    }
  });
  it("retains an unconfirmed Native owner and lease while shutting down other Missions", async () => {
    const f = await createShutdownFixture();
    const retained = randomUUID();
    const other = randomUUID();
    const stopForDeletion = vi.fn(async () => {
      throw new Error("Native stop unconfirmed");
    });
    const owner = {
      kind: "flow",
      execution: {
        executionId: "native-execution",
        stopForDeletion,
        getState: async () => ({ status: "cancelled" }),
      },
    } as unknown as LocalHostCoreActiveOwner;
    try {
      const original = await f.lifecycle.ownerScope.acquire(retained);
      await f.lifecycle.ownerScope.acquire(other);
      f.owners.setControlOwner(retained, owner, "live");
      await expect(f.app.dispose()).rejects.toThrow("Mission application shutdown failed.");
      expect(f.owners.controlOwner(retained)).toBe(owner);
      expect(f.lifecycle.ownerScope.currentGuard(retained)).toEqual(original);
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId: retained })).snapshot.lease
          ?.claimId,
      ).toBe(original.claimId);
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId: other })).snapshot.lease,
      ).toBeUndefined();
      expect(f.closeResources).not.toHaveBeenCalled();
      stopForDeletion.mockImplementation(async () => f.markNativeStopped("native-execution"));
      await f.app.dispose();
      expect(f.owners.controlOwner(retained)).toBeUndefined();
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId: retained })).snapshot.lease,
      ).toBeUndefined();
      expect(f.closeResources).toHaveBeenCalledOnce();
    } finally {
      stopForDeletion.mockImplementation(async () => f.markNativeStopped("native-execution"));
      await f.cleanup();
    }
  });
  it.each(["native-stop", "settlement"] as const)(
    "retains an active Flow when %s fails and allows a confirmed retry",
    async (failure) => {
      const f = await createShutdownFixture();
      const missionId = randomUUID();
      const stopForDeletion = vi.fn(async () => {
        if (failure === "native-stop") throw new Error("Native stop unconfirmed");
      });
      const settlement =
        failure === "settlement"
          ? Promise.reject(new Error("Native settlement unconfirmed"))
          : Promise.resolve();
      void settlement.catch(() => undefined);
      const handle = {
        executionId: "active-native",
        stopForDeletion,
        cancel: vi.fn(),
        getState: async () => ({ status: "cancelled" }),
      };
      const active = { handle, settlement };
      const owner = { kind: "flow", execution: handle } as unknown as LocalHostCoreActiveOwner;
      try {
        const guard = await f.lifecycle.ownerScope.acquire(missionId);
        f.owners.setActive(missionId, active);
        f.owners.setControlOwner(missionId, owner, "live");
        await expect(f.app.dispose()).rejects.toThrow("Mission application shutdown failed.");
        expect(f.owners.active(missionId)).toBe(active);
        expect(f.owners.controlOwner(missionId)).toBe(owner);
        expect(
          (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease?.claimId,
        ).toBe(guard.claimId);
        expect(f.closeResources).not.toHaveBeenCalled();
        stopForDeletion.mockImplementation(async () => undefined);
        active.settlement = Promise.resolve();
        await f.app.dispose();
        expect(f.owners.active(missionId)).toBeUndefined();
        expect(f.owners.controlOwner(missionId)).toBeUndefined();
        expect(
          (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
        ).toBeUndefined();
        expect(f.closeResources).toHaveBeenCalledOnce();
        expect(handle.cancel).not.toHaveBeenCalled();
      } finally {
        stopForDeletion.mockImplementation(async () => undefined);
        active.settlement = Promise.resolve();
        await f.cleanup();
      }
    },
  );
  it("retries resource close failures without repeating already released owners", async () => {
    const f = await createShutdownFixture();
    try {
      const missionId = randomUUID();
      await f.lifecycle.ownerScope.acquire(missionId);
      const release = vi.spyOn(f.lifecycle.controller, "release");
      f.closeResources.mockRejectedValueOnce(new Error("feed close failed"));
      await expect(f.app.dispose()).rejects.toThrow("Mission application shutdown failed.");
      await f.app.dispose();
      expect(release).toHaveBeenCalledOnce();
      expect(f.closeResources).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
    }
  });
  it("never revokes a successor lease while retrying its own failed release", async () => {
    const f = await createShutdownFixture();
    const missionId = randomUUID();
    try {
      const original = await f.lifecycle.ownerScope.acquire(missionId);
      vi.spyOn(f.lifecycle.controller, "release").mockRejectedValueOnce(new Error("write failed"));
      await expect(f.app.dispose()).rejects.toThrow("Mission application shutdown failed.");
      await f.lifecycle.controller.revoke({ missionId });
      const successor = await f.lifecycle.controller.claim({
        missionId,
        claimId: randomUUID(),
        leaseMs: 30_000,
      });
      expect(successor.claimId).not.toBe(original.claimId);
      await f.app.dispose();
      expect(
        (await f.lifecycle.controller.readSnapshot({ missionId })).snapshot.lease?.claimId,
      ).toBe(successor.claimId);
      await f.lifecycle.controller.release({ missionId, guard: successor });
    } finally {
      await f.cleanup();
    }
  });
  it("rejects a complete foreign command and run kernel at the protocol facade", () => {
    const foreign = {
      integration: { run: vi.fn(), missionControl: { commands: {}, resume: vi.fn() } },
    } as unknown as LocalHostMissionApplication;
    expect(() =>
      createLocalHostApplication({
        missionApplication: foreign,
        integrationCapability: async () => {
          throw new Error("not used");
        },
        catalog: {
          listProjects: async () => [],
          getProjectRevision: async () => undefined,
          listExecutors: async () => [],
        },
        missions: {
          get: async () => undefined,
          list: async () => [],
          query: async () => {
            throw new Error("not used");
          },
        },
        workspace: {
          stat: async () => ({ isDirectory: () => true }),
          access: async () => undefined,
          realpath: async (path) => path,
        },
        board: {
          list: async () => undefined,
          read: async () => undefined,
          search: async () => undefined,
        },
        runtime: { resolver: {} as never },
      }),
    ).toThrow("Mission application must be created by the shared Local Host application factory.");
    expect(foreign.integration.run).not.toHaveBeenCalled();
  });
  it.each(["cli", "desktop"] as const)(
    "runs and controls the same owned Session for %s resource composition",
    async (surface) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-mission-application-"));
      const paths = new PragmaPaths({ pragmaHome: home });
      let missionId: string | undefined;
      const guardedNativeTurn = vi.fn();
      const effects = vi.fn(async () => {
        if (missionId !== undefined)
          guardedNativeTurn(lifecycle.ownerScope.currentGuard(missionId));
        return { outputText: "done" };
      });
      const runtime = defineRuntimeTestDriver<never, { id: string }>({
        descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
        createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
        restoreSession: ({ systemSessionId }) => ({ id: systemSessionId }),
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn: effects,
        mapEvent: () => ({ events: [] }),
      });
      const runtimes = createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: "codex",
      });
      const resources = createPublishedProjectResources();
      await writePublishedProjectFixture(home, resources);
      const compiler = createLocalHostNodeMissionCompiler({ pragmaHome: home, runtimes });
      const catalog = createLocalHostProjectCatalogFromHome({
        pragmaHome: home,
        runtimes,
        compiler,
      });
      const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
      const executions = createSqliteExecutionStore({ pragmaHome: home });
      const sessions = createFileExpertSessionStore({ pragmaHome: home, executions });
      const memory = createLocalHostRunMemory({ pragmaHome: home });
      const lifecycle = createLocalHostMissionController({ missionsPath: paths.missionsRoot() });
      const owners = new MissionExecutionOwner();
      const association = createMissionSessionAssociationResolver({
        controller: lifecycle.controller,
        executions,
        sessions,
        repositorySessionId: async () => undefined,
      });
      const closeResources = vi.fn(async () => {
        await memory.close();
        await executions.close();
      });
      const app = createLocalHostMissionApplication({
        closeResources,
        lifecycle,
        client: { surface, version: "test", instanceId: randomUUID() },
        resolveExecutor: catalog.resolve,
        execution: {
          pragmaHome: home,
          missions,
          runtimes,
          executionStore: executions,
          expertSessionStore: sessions,
          executionOwner: owners,
          ownerLifetime: "host",
          resourcePorts: createLocalHostNodeExecutionResourcePorts({
            pragmaHome: home,
            missions,
            runtimes,
            compiler,
            memory,
            usageSink: { record: async () => undefined },
          }),
          controllerFacts: {
            controller: lifecycle.controller,
            hasEnvelope: async () => false,
            resolveSessionId: association,
            resolveMissionBinding: async (missionId) =>
              findMissionPinnedBinding(
                (await lifecycle.controller.readSnapshot({ missionId })).events,
              ),
            executors: catalog.resolve,
            compiler,
          },
        },
      });
      try {
        const expert = resources.find((resource) => resource.kind === "Expert")!;
        const first = await app.integration.run.start({
          requestId: randomUUID(),
          command: "expert.run",
          executor: { kind: "expert", id: expert.metadata.id },
          project: { projectId: "studio", revision: 1 },
          workspace: {
            schemaVersion: "pragma.integration-workspace/v1",
            requestedPath: home,
            canonicalPath: home,
            identityHash: `sha256:${createHash("sha256").update(home).digest("hex")}`,
          },
          prompt: "first",
          detach: false,
        });
        missionId = first.missionId;
        expect((await first.outcome).status).toBe("succeeded");
        const sessionId = await association(missionId);
        expect(sessionId).toBeDefined();
        const originalSession = (await sessions.get(sessionId!))!;
        const originalRoot = originalSession.contexts[originalSession.rootContextId]!;
        const requestId = randomUUID();
        const command = {
          missionId,
          requestId,
          kind: "send" as const,
          payload: { kind: "send" as const, input: { prompt: "followup", attachments: [] } },
        };
        await app.integration.missionControl.commands.submit(command);
        const receipt = await app.integration.missionControl.commands.waitForTerminal({
          missionId,
          requestId,
          timeoutMs: 10_000,
        });
        expect(receipt).toMatchObject({ state: "applied" });
        await app.integration.missionControl.commands.waitExecution!({
          missionId,
          executionId: receipt.result!["executionId"] as string,
        });
        await app.integration.missionControl.commands.submit(command);
        expect(effects).toHaveBeenCalledTimes(2);
        const after = (await sessions.get(sessionId!))!;
        expect(after.rootContextId).toBe(originalSession.rootContextId);
        expect(after.contexts[after.rootContextId]?.snapshot).toEqual(originalRoot.snapshot);
        expect(lifecycle.ownerScope.currentGuard(missionId)).toBeDefined();
        expect(guardedNativeTurn).toHaveBeenCalledWith(
          lifecycle.ownerScope.currentGuard(missionId),
        );
        const repeated = await app.integration.missionControl.commands.waitForTerminal({
          missionId,
          requestId,
          timeoutMs: 10_000,
        });
        expect(repeated.result).toEqual(receipt.result);
        await Promise.all([app.dispose(), app.dispose()]);
        expect(owners.controlOwner(missionId)).toBeUndefined();
        expect(closeResources).toHaveBeenCalledTimes(1);
        expect(
          (await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
        ).toBeUndefined();
      } finally {
        await app.dispose();
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

async function createShutdownFixture() {
  const home = await mkdtemp(join(tmpdir(), "pragma-mission-shutdown-"));
  const paths = new PragmaPaths({ pragmaHome: home });
  const runtime = defineRuntimeTestDriver<never, { id: string }>({
    descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
    createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
    restoreSession: ({ systemSessionId }) => ({ id: systemSessionId }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async () => ({ outputText: "unused" }),
    mapEvent: () => ({ events: [] }),
  });
  const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "codex" });
  const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
  const executions = createSqliteExecutionStore({ pragmaHome: home });
  // These shutdown fixtures model a running Native Flow, not a terminal receipt.
  const runningNativeIds = new Set(["admitted-native", "native-execution", "active-native"]);
  const getExecution = executions.get.bind(executions);
  vi.spyOn(executions, "get").mockImplementation(async (executionId) => {
    if (runningNativeIds.has(executionId))
      return { executionId, status: "running" } as Awaited<ReturnType<typeof executions.get>>;
    return await getExecution(executionId);
  });
  const memory = createLocalHostRunMemory({ pragmaHome: home });
  const lifecycle = createLocalHostMissionController({ missionsPath: paths.missionsRoot() });
  const owners = new MissionExecutionOwner();
  const closeResources = vi.fn(async () => {
    await memory.close();
  });
  const app = createLocalHostMissionApplication({
    lifecycle,
    closeResources,
    client: { surface: "cli", version: "test", instanceId: randomUUID() },
    resolveExecutor: async () => undefined,
    execution: {
      pragmaHome: home,
      missions,
      runtimes,
      executionStore: executions,
      executionOwner: owners,
      resourcePorts: createLocalHostNodeExecutionResourcePorts({
        pragmaHome: home,
        missions,
        runtimes,
        compiler: createLocalHostNodeMissionCompiler({ pragmaHome: home, runtimes }),
        memory,
        usageSink: { record: async () => undefined },
      }),
    },
  });
  return {
    app,
    lifecycle,
    owners,
    closeResources,
    markNativeStopped: (executionId: string) => {
      runningNativeIds.delete(executionId);
    },
    cleanup: async () => {
      await app.dispose();
      await memory.close();
      await executions.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
