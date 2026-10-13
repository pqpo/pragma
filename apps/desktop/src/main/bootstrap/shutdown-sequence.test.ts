import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalHostMissionApplication,
  createLocalHostMissionController,
  MissionExecutionOwner,
  createSqliteExecutionStore,
} from "@pragma/local-host";
import {
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  PragmaPaths,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { describe, expect, it, vi } from "vitest";
import { installDesktopShutdown } from "./shutdown-sequence.ts";

function fixture(dispose: () => Promise<void>) {
  let beforeQuit: (event: { preventDefault(): void }) => void = () => undefined;
  const quit = vi.fn();
  const reportFailure = vi.fn();
  installDesktopShutdown({
    app: {
      on: (_event, listener) => (beforeQuit = listener),
      quit,
    },
    dispose,
    reportFailure,
  });
  return {
    quit,
    reportFailure,
    requestQuit: () => {
      const preventDefault = vi.fn();
      beforeQuit({ preventDefault });
      return preventDefault;
    },
  };
}

describe("Desktop actual quit adapter", () => {
  it("waits for shared shutdown and joins repeated quit requests before permitting Electron exit", async () => {
    let complete = () => undefined as void;
    const pending = new Promise<void>((resolve) => (complete = resolve));
    const dispose = vi.fn(() => pending);
    const f = fixture(dispose);
    expect(f.requestQuit()).toHaveBeenCalledOnce();
    expect(f.requestQuit()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(f.quit).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(f.requestQuit()).not.toHaveBeenCalled();
    expect(f.reportFailure).not.toHaveBeenCalled();
  });

  it("keeps Electron alive after unconfirmed Native stop and permits a later shutdown retry", async () => {
    const failure = new Error("Native owner retained");
    const dispose = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const f = fixture(dispose);
    f.requestQuit();
    await vi.waitFor(() => expect(f.reportFailure).toHaveBeenCalledWith(failure));
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.requestQuit()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

it("the Electron adapter retains real shared Host lease and resources until Native stop confirms", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-desktop-quit-"));
  const lifecycle = createLocalHostMissionController({ missionsPath: root });
  const owners = new MissionExecutionOwner();
  const closeResources = vi.fn(async () => undefined);
  let executionStatus = "running";
  const stopForDeletion = vi.fn(async (): Promise<void> => {
    throw new Error("Native stop unconfirmed");
  });
  const application = createLocalHostMissionApplication({
    lifecycle,
    closeResources,
    client: { surface: "desktop", version: "test", instanceId: randomUUID() },
    resolveExecutor: async () => undefined,
    execution: {
      pragmaHome: root,
      executionOwner: owners as Parameters<
        typeof createLocalHostMissionApplication
      >[0]["execution"]["executionOwner"],
      resourcePorts: { createCompileService: () => ({}) as never } as never,
      missions: {} as never,
      executionStore: {
        get: async () => ({ status: executionStatus }),
        listInvocations: async () => [],
      } as never,
      expertSessionStore: {} as never,
      runtimes: {} as never,
    },
  });
  const missionId = randomUUID();
  const f = fixture(application.dispose);
  try {
    const guard = await lifecycle.ownerScope.acquire(missionId);
    owners.setControlOwner(
      missionId,
      {
        kind: "flow",
        execution: { executionId: randomUUID(), stopForDeletion } as never,
      },
      "live",
    );
    f.requestQuit();
    await vi.waitFor(() => expect(f.reportFailure).toHaveBeenCalledOnce());
    expect(f.quit).not.toHaveBeenCalled();
    expect(closeResources).not.toHaveBeenCalled();
    expect((await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease?.claimId).toBe(
      guard.claimId,
    );
    expect(owners.controlOwner(missionId)).toBeDefined();
    stopForDeletion.mockImplementation(async () => {
      executionStatus = "cancelled";
    });
    f.requestQuit();
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(closeResources).toHaveBeenCalledOnce();
    expect(owners.controlOwner(missionId)).toBeUndefined();
    expect((await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease).toBeUndefined();
  } finally {
    stopForDeletion.mockImplementation(async () => {
      executionStatus = "cancelled";
    });
    await application.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

// Keep a real Core Session registered in the Host while an ordinary close and
// Electron shutdown overlap, as can happen when bindings change before quitting.
it.each([
  "closing",
  "closed",
  "native stop failure",
  "cleanup failure",
  "persistence and read failure",
  "terminal-release",
  "checkpoint-release",
  "terminal-release-native failure",
  "checkpoint-release-native failure",
  "terminal-release-cleanup failure",
  "checkpoint-release-cleanup failure",
] as const)(
  "Dock quit releases a real ExpertSession after %s and keeps retries usable",
  async (outcome) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-desktop-session-quit-"));
    const executions = createSqliteExecutionStore({ pragmaHome: home });
    const lifecycle = createLocalHostMissionController({ missionsPath: join(home, "missions") });
    const owners = new MissionExecutionOwner();
    let completeStop = () => undefined as void;
    const stopGate = new Promise<void>((resolve) => (completeStop = resolve));
    const releaseBoundary = outcome.startsWith("terminal-release")
      ? "terminal"
      : outcome.startsWith("checkpoint-release")
        ? "checkpoint"
        : undefined;
    const nativeFailure = outcome.endsWith("native failure") || outcome === "native stop failure";
    const cleanupFailure = outcome.endsWith("cleanup failure");
    const persistenceFailure = outcome === "persistence and read failure";
    let failing = nativeFailure || cleanupFailure || persistenceFailure;
    let activeStops = 0;
    let maximumActiveStops = 0;
    const nativeClose = vi.fn(async () => {
      activeStops += 1;
      maximumActiveStops = Math.max(maximumActiveStops, activeStops);
      try {
        if (outcome === "closing" || (releaseBoundary !== undefined && !cleanupFailure))
          await stopGate;
        if (failing && nativeFailure) throw new Error("Native stop failed");
      } finally {
        activeStops -= 1;
      }
    });
    const afterDestroy = vi.fn(async () => {
      if (releaseBoundary !== undefined && cleanupFailure) await stopGate;
      if (failing && cleanupFailure) throw new Error("Cleanup failed");
    });
    const runtime = defineRuntimeTestDriver({
      descriptor: { id: "quit-test", kind: "test", displayName: "Quit test" },
      createSession: (context) => ({ id: context.systemSessionId }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "done" }),
      mapEvent: () => ({ events: [] }),
      closeSession: nativeClose,
    });
    const runtimes = createStaticRuntimeResolver({
      runtimes: [runtime],
      defaultRuntimeId: "quit-test",
    });
    const sessions = createFileExpertSessionStore({ pragmaHome: home, executions });
    let failStateRead = false;
    const get = sessions.get.bind(sessions);
    vi.spyOn(sessions, "get").mockImplementation(async (id) => {
      if (failStateRead) {
        failStateRead = false;
        throw new Error("State read failed");
      }
      return await get(id);
    });
    const transact = sessions.transact.bind(sessions);
    vi.spyOn(sessions, "transact").mockImplementation(
      async (id, action, claimId) =>
        await transact(
          id,
          async (snapshot) => {
            const next = await action(snapshot);
            if (failing && persistenceFailure && next.session.status === "closed") {
              failStateRead = true;
              throw new Error("Close persistence failed");
            }
            return next;
          },
          claimId,
        ),
    );
    const core = createPragma({
      pragmaHome: home,
      runtimes,
      executionStore: executions,
      expertSessionStore: sessions,
    });
    const expert = await defineExpert({
      id: "qvttest000000001",
      name: "Quit test",
      description: "",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
      hooks: { afterSessionDestroy: afterDestroy },
    });
    if (persistenceFailure) vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const session = await core.experts.createSession(expert);
    const closeResources = vi.fn(async () => undefined);
    const application = createLocalHostMissionApplication({
      lifecycle,
      client: { surface: "desktop", version: "test", instanceId: randomUUID() },
      closeResources,
      resolveExecutor: async () => undefined,
      execution: {
        pragmaHome: home,
        executionOwner: owners as Parameters<
          typeof createLocalHostMissionApplication
        >[0]["execution"]["executionOwner"],
        runtimes,
        executionStore: executions,
        resourcePorts: { createCompileService: () => ({}) as never } as never,
        missions: {} as never,
      },
    });
    const missionId = randomUUID();
    const f = fixture(application.dispose);
    try {
      const turn = await session.prompt("finish before quit");
      await turn.result;
      await turn.settled;
      await session.waitForPromptProcessing();
      if (!persistenceFailure) await lifecycle.ownerScope.acquire(missionId);
      owners.setControlOwner(missionId, { kind: "session", session }, "live");
      if (releaseBoundary !== undefined) {
        const releasing =
          releaseBoundary === "terminal"
            ? session.releaseAfterTerminal()
            : session.releaseAfterHumanCheckpoint();
        void releasing.catch(() => undefined);
        await vi.waitFor(() => expect(nativeClose).toHaveBeenCalledOnce());
        if (cleanupFailure) await vi.waitFor(() => expect(afterDestroy).toHaveBeenCalledOnce());
        const closing = session.close();
        void closing.catch(() => undefined);
        expect(activeStops).toBe(cleanupFailure ? 0 : 1);
        expect(nativeClose).toHaveBeenCalledOnce();
        await expect(
          access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId)),
        ).resolves.toBeUndefined();
      } else if (outcome === "closed") await session.close();
      else if (outcome === "closing") {
        const closing = session.close();
        expect(session.close()).toBe(closing);
        expect(session.releaseAfterTerminal()).toBe(closing);
        expect(session.releaseAfterHumanCheckpoint()).toBe(closing);
        await vi.waitFor(() => expect(nativeClose).toHaveBeenCalledOnce());
      } else {
        await expect(session.close()).rejects.toThrow(
          persistenceFailure
            ? "Close persistence failed"
            : nativeFailure
              ? "Native stop failed"
              : "Cleanup failed",
        );
        await expect(
          access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId)),
        ).resolves.toBeUndefined();
      }
      f.requestQuit();
      f.requestQuit();
      if (outcome === "closing" || releaseBoundary !== undefined) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.quit).not.toHaveBeenCalled();
        expect(closeResources).not.toHaveBeenCalled();
        completeStop();
      }
      if (failing) {
        await vi.waitFor(() => expect(f.reportFailure).toHaveBeenCalledOnce());
        expect(f.quit).not.toHaveBeenCalled();
        expect(closeResources).not.toHaveBeenCalled();
        expect(owners.controlOwner(missionId)).toBeDefined();
        if (persistenceFailure) {
          expect(f.reportFailure.mock.calls[0]?.[0]).toMatchObject({
            errors: expect.arrayContaining([
              expect.objectContaining({ message: "State read failed" }),
            ]),
          });
          await vi.advanceTimersByTimeAsync(40_000);
          await vi.waitFor(async () => {
            const lease = JSON.parse(
              await readFile(
                new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId),
                "utf8",
              ),
            ) as { expiresAt: string };
            expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now());
          });
          expect(await sessions.claimLease(session.sessionId, "competing-owner", 30_000)).toBe(
            false,
          );
        } else {
          expect(
            (await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
          ).toBeDefined();
        }
        failing = false;
        f.requestQuit();
      }
      await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
      expect(closeResources).toHaveBeenCalledOnce();
      expect(maximumActiveStops).toBe(1);
      expect(owners.controlOwner(missionId)).toBeUndefined();
      expect((await session.getState()).status).toBe("closed");
      await expect(
        access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease,
      ).toBeUndefined();
      expect(f.requestQuit()).not.toHaveBeenCalled();
      if (!failing && (outcome === "closed" || outcome === "closing")) {
        expect(f.reportFailure).not.toHaveBeenCalled();
        expect(nativeClose).toHaveBeenCalledOnce();
      }
    } finally {
      failing = false;
      completeStop();
      await session.close();
      if (persistenceFailure) vi.useRealTimers();
      await application.dispose();
      await executions.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
