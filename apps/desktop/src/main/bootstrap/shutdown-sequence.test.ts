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

// Keep a real Core Session registered while shutdown overlaps ordinary close,
// resource release or an interrupted Mission deletion.
it.each([
  "deletion frozen",
  "deletion stopped",
  "deletion checkpoint",
  "deletion pending native success",
  "deletion pending native rejection",
  "deletion native failure",
  "deletion cleanup failure",
  "closing",
  "closed",
  "native stop failure",
  "cleanup failure",
  "persistence and read failure",
  "terminal-only-pending native success",
  "checkpoint-only-pending native success",
  "terminal-only-pending native rejection",
  "checkpoint-only-pending native rejection",
  "terminal-only-pending hook success",
  "checkpoint-only-pending hook success",
  "terminal-only-pending hook rejection",
  "checkpoint-only-pending hook rejection",
  "terminal-only-pending native close",
  "terminal-only-native failure",
  "checkpoint-only-native failure",
  "terminal-only-cleanup failure",
  "checkpoint-only-cleanup failure",
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
    const deletionFrozen = outcome.startsWith("deletion");
    const releaseOnly = outcome.includes("-only-");
    const pendingRelease = outcome.includes("pending");
    const pendingHook = outcome.includes("pending hook");
    const pendingClose = outcome.endsWith("native close");
    const lateRejection = outcome.endsWith("rejection");
    const deadlines: (() => void)[] = [];
    let restoreDeadline = () => undefined as void;
    const leaseTiming = releaseOnly || deletionFrozen || outcome === "persistence and read failure";
    const releaseBoundary = outcome.startsWith("terminal-release")
      ? "terminal"
      : outcome.startsWith("checkpoint-release")
        ? "checkpoint"
        : undefined;
    const nativeFailure =
      outcome.endsWith("native failure") ||
      outcome === "native stop failure" ||
      (pendingRelease && !pendingHook && lateRejection);
    const cleanupFailure = outcome.endsWith("cleanup failure") || (pendingHook && lateRejection);
    const persistenceFailure = outcome === "persistence and read failure";
    let failing = nativeFailure || cleanupFailure || persistenceFailure;
    let activeStops = 0;
    let maximumActiveStops = 0;
    let primaryNativeId: string | undefined;
    const nativeClose = vi.fn(async (native: { id: string }) => {
      if (native.id !== primaryNativeId) return;
      activeStops += 1;
      maximumActiveStops = Math.max(maximumActiveStops, activeStops);
      try {
        if (
          (pendingRelease && !pendingHook) ||
          outcome === "closing" ||
          (releaseBoundary !== undefined && !cleanupFailure)
        )
          await stopGate;
        if (failing && nativeFailure) throw new Error("Native stop failed");
      } finally {
        activeStops -= 1;
      }
    });
    const afterDestroy = vi.fn(async () => {
      if (pendingHook || (releaseBoundary !== undefined && cleanupFailure)) await stopGate;
      if (failing && cleanupFailure) throw new Error("Cleanup failed");
    });
    const runtime = defineRuntimeTestDriver({
      descriptor: { id: "quit-test", kind: "test", displayName: "Quit test" },
      createSession: (context) => {
        primaryNativeId ??= context.systemSessionId;
        return { id: context.systemSessionId };
      },
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
    if (leaseTiming) vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
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
      const ordinaryClose = vi.spyOn(session, "close");
      const terminalRelease = vi.spyOn(session, "releaseAfterTerminal");
      const checkpointRelease = vi.spyOn(session, "releaseAfterHumanCheckpoint");
      const originalState = await session.getState();
      if (deletionFrozen) {
        if (outcome === "deletion checkpoint")
          await sessions.transact(session.sessionId, ({ session: state, prompts }) => ({
            result: undefined,
            session: { ...state, lastStatus: "waiting" },
            prompts,
          }));
        session.freezeForDeletion();
        if (pendingRelease) void session.stopForDeletion().catch(() => undefined);
        if (outcome === "deletion stopped") await session.stopForDeletion();
        else if (nativeFailure && !pendingRelease)
          await expect(session.stopForDeletion()).rejects.toThrow("Native stop failed");
      } else if (releaseOnly) {
        if (outcome.startsWith("checkpoint")) {
          await sessions.transact(session.sessionId, ({ session: state, prompts }) => ({
            result: undefined,
            session: { ...state, lastStatus: "waiting" },
            prompts,
          }));
        }
      } else if (releaseBoundary !== undefined) {
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
      if (pendingRelease) {
        // A second, independent real Session must close even if the first hangs.
        const otherExpert = await defineExpert({
          id: "qvttest000000002",
          name: "Other quit test",
          description: "",
          tags: [],
          scope: "test",
          workspace: home,
          pragmaHome: home,
        });
        const other = await core.experts.createSession(otherExpert);
        const otherTurn = await other.prompt("independent owner");
        await otherTurn.result;
        await otherTurn.settled;
        await other.waitForPromptProcessing();
        const otherId = randomUUID();
        await lifecycle.ownerScope.acquire(otherId);
        owners.setControlOwner(otherId, { kind: "session", session: other }, "live");
        const scheduleTimeout = globalThis.setTimeout;
        const deadlineSpy = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((callback, delay, ...args) => {
            if (delay === 15_000) deadlines.push(callback as () => void);
            return scheduleTimeout(callback, delay, ...args);
          });
        restoreDeadline = () => deadlineSpy.mockRestore();
        f.requestQuit();
        await vi.waitFor(() => expect(deadlines).toHaveLength(1));
        await vi.waitFor(() => expect(nativeClose).toHaveBeenCalledOnce());
        if (pendingHook) await vi.waitFor(() => expect(afterDestroy).toHaveBeenCalledOnce());
        if (pendingClose) void session.close().catch(() => undefined);
        deadlines[0]!();
        await vi.waitFor(() => expect(f.reportFailure).toHaveBeenCalledOnce());
        expect(f.reportFailure.mock.calls[0]?.[0]).toMatchObject({
          errors: expect.arrayContaining([
            expect.objectContaining({ name: "OwnerShutdownPendingError" }),
          ]),
        });
        expect(owners.controlOwner(missionId)).toBeDefined();
        expect(owners.controlOwner(otherId)).toBeUndefined();
        expect((await other.getState()).status).toBe("open");
        expect(nativeClose).toHaveBeenCalledTimes(2);
        expect(closeResources).not.toHaveBeenCalled();
        expect(f.quit).not.toHaveBeenCalled();
        await expect(session.prompt("still sealed")).rejects.toThrow();
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
        expect(await sessions.claimLease(session.sessionId, "competing-owner", 30_000)).toBe(false);
        f.requestQuit();
        // The first attempt visited both owners; retry waits on the retained owner.
        await vi.waitFor(() => expect(deadlines).toHaveLength(3));
        deadlines[2]!();
        await vi.waitFor(() => expect(f.reportFailure).toHaveBeenCalledTimes(2));
        expect(nativeClose).toHaveBeenCalledTimes(2);
        expect(afterDestroy).toHaveBeenCalledTimes(pendingHook ? 1 : 0);
        expect(ordinaryClose).toHaveBeenCalledTimes(pendingClose ? 1 : 0);
        const release = (outcome.startsWith("checkpoint") ? checkpointRelease : terminalRelease)
          .mock.results[0]?.value as Promise<void>;
        completeStop();
        if (lateRejection)
          await expect(release).rejects.toThrow(
            pendingHook ? "Cleanup failed" : "Native stop failed",
          );
        else await release;
        await new Promise<void>((resolve) => setImmediate(resolve));
        failing = false;
        f.requestQuit();
        await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
        expect(closeResources).toHaveBeenCalledOnce();
        expect(owners.controlOwner(missionId)).toBeUndefined();
        expect((await session.getState()).status).toBe(pendingClose ? "closed" : "open");
        expect(nativeClose).toHaveBeenCalledTimes(2 + (lateRejection && !pendingHook ? 1 : 0));
        expect(afterDestroy).toHaveBeenCalledTimes(lateRejection && pendingHook ? 2 : 1);
        expect(maximumActiveStops).toBe(1);
        if (deletionFrozen) expect(await session.getState()).toEqual(originalState);
        await expect(
          access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await other.close();
        return;
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
        }
        if (leaseTiming) {
          await expect(
            access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId)),
          ).resolves.toBeUndefined();
          await expect(session.prompt("must remain sealed")).rejects.toThrow();
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
      expect((await session.getState()).status).toBe(
        releaseOnly || deletionFrozen ? "open" : "closed",
      );
      if (deletionFrozen) {
        expect(ordinaryClose).not.toHaveBeenCalled();
        expect(await session.getState()).toEqual(
          outcome === "deletion checkpoint"
            ? { ...originalState, lastStatus: "waiting" }
            : originalState,
        );
      }
      if (releaseOnly) {
        expect(ordinaryClose).not.toHaveBeenCalled();
        expect(terminalRelease).toHaveBeenCalledTimes(outcome.startsWith("terminal") ? 2 : 0);
        expect(checkpointRelease).toHaveBeenCalledTimes(outcome.startsWith("checkpoint") ? 2 : 0);
        expect(nativeClose).toHaveBeenCalledTimes(nativeFailure ? 2 : 1);
        expect(afterDestroy).toHaveBeenCalledTimes(cleanupFailure ? 2 : 1);
      }
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
      if (leaseTiming) vi.useRealTimers();
      restoreDeadline();
      await application.dispose();
      await executions.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  15_000,
);
