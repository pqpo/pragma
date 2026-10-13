import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createNoopLoggerProvider,
  createPragma,
  PragmaPaths,
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
} from "../src/index.ts";
import { createFileExpertSessionStore } from "../src/execution/expert-session-store.ts";
import { createMcpToolRegistryPool } from "../src/mcp-tools.ts";
import { defineRuntimeFeatures, runtimeFeature } from "../src/runtime/features.ts";
import {
  createExpertToolsHttpMcpFeature,
  type RuntimeMcpPreparation,
} from "../src/runtime/mcp-feature.ts";
import { createInMemoryExecutionStore, createRuntimeTestFeatures } from "../src/testing/index.ts";

describe("ExpertSession ordinary closure", () => {
  it.each([
    "terminal-only-native failure",
    "checkpoint-only-native failure",
    "terminal-only-cleanup failure",
    "checkpoint-only-cleanup failure",
    "terminal-only-lease lost",
    "checkpoint-only-lease lost",
    "success",
    "pending close",
    "pending release",
    "release waiting admission",
    "released terminal",
    "released checkpoint",
    "released owner taken",
    "cleanup failure",
    "persistence failure",
    "persistence and read failure",
    "native stop failure",
    "lease lost",
  ] as const)("releases real MCP registrations after confirmed stop: %s", async (outcome) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-expert-close-"));
    const pool = createMcpToolRegistryPool();
    const registrations: RuntimeMcpPreparation["registration"][] = [];
    let failing = false;
    const nativeFailure =
      outcome.endsWith("native failure") ||
      outcome.endsWith("lease lost") ||
      outcome === "native stop failure";
    let completeRelease = () => undefined as void;
    const releaseGate = new Promise<void>((resolve) => (completeRelease = resolve));
    let completeStop = () => undefined as void;
    const stopGate = new Promise<void>((resolve) => (completeStop = resolve));
    const nativeClose = vi.fn(async () => {
      if (failing && outcome === "pending close") await stopGate;
      if (failing && nativeFailure) throw new Error("native stop failed");
    });
    const afterDestroy = vi.fn(() => {
      if (failing && outcome.endsWith("cleanup failure")) throw new Error("cleanup failed");
    });
    const mcp = createExpertToolsHttpMcpFeature({
      readiness: runtimeFeature.degraded("Real MCP lifecycle regression fixture."),
      pool,
      resourcePrefix: "close-test",
    });
    const runtime = defineRuntimeDriver({
      descriptor: { id: "close-test", kind: "test", displayName: "Close Test" },
      features: defineRuntimeFeatures({
        ...createRuntimeTestFeatures({ enabled: ["close", "resume"] }),
        mcp,
      }),
      createSession(context) {
        registrations.push(context.features.mcp.registration);
        return { id: context.systemSessionId };
      },
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn: () => ({ outputText: "ok" }),
      mapEvent: () => ({ events: [] }),
      closeSession: nativeClose,
    });
    const expert = await defineExpert({
      id: "c10sexpt00000001",
      name: "Close test",
      description: "Close test",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
      hooks: { afterSessionDestroy: afterDestroy },
    });
    const executions = createInMemoryExecutionStore();
    const sessions = createFileExpertSessionStore({ pragmaHome: home, executions });
    let failStateRead = false;
    const get = sessions.get.bind(sessions);
    vi.spyOn(sessions, "get").mockImplementation(async (id) => {
      if (failStateRead) {
        failStateRead = false;
        throw new Error("state read failed");
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
            if (
              failing &&
              (outcome === "persistence failure" || outcome === "persistence and read failure") &&
              next.session.status === "closed"
            ) {
              if (outcome === "persistence and read failure") failStateRead = true;
              throw new Error("close persistence failed");
            }
            return next;
          },
          claimId,
        ),
    );
    const app = createPragma({
      pragmaHome: home,
      executionStore: executions,
      expertSessionStore: sessions,
      loggerProvider: createNoopLoggerProvider(),
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: runtime.descriptor.id,
      }),
    });
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const session = await app.experts.createSession(expert);
    try {
      const first = await session.prompt("first");
      await expect(first.result).resolves.toBe("ok");
      await first.settled;
      await session.refreshRuntimeSessions();
      const second = await session.prompt("second");
      await expect(second.result).resolves.toBe("ok");
      await second.settled;
      expect(registrations).toHaveLength(2);
      // Refresh closes the final old registration before opening its successor.
      await expect(fetch(registrations[0]!.url)).rejects.toThrow();
      expect((await fetch(registrations[1]!.url)).status).not.toBe(404);
      failing = true;
      if (outcome.includes("-only-")) {
        const release = () =>
          outcome.startsWith("terminal")
            ? session.releaseAfterTerminal()
            : session.releaseAfterHumanCheckpoint();
        const original = await session.getState();
        await expect(release()).rejects.toThrow(
          nativeFailure ? "native stop failed" : "cleanup failed",
        );
        await expect(session.prompt("sealed after failed release")).rejects.toThrow();
        const leasePath = new PragmaPaths({ pragmaHome: home }).expertSessionLease(
          session.sessionId,
        );
        expect(await session.getState()).toEqual(original);
        await expect(access(leasePath)).resolves.toBeUndefined();
        if (nativeFailure) expect((await fetch(registrations[1]!.url)).status).not.toBe(404);
        else await expect(fetch(registrations[1]!.url)).rejects.toThrow();
        if (outcome.endsWith("lease lost")) {
          vi.setSystemTime(Date.now() + 40_000);
          expect(await sessions.claimLease(session.sessionId, "successor", 30_000)).toBe(true);
          const successorLease = await readFile(leasePath, "utf8");
          const stopped = nativeClose.mock.calls.length;
          failing = false;
          await expect(release()).rejects.toThrow("lease is no longer owned");
          expect(nativeClose).toHaveBeenCalledTimes(stopped);
          expect(await session.getState()).toEqual(original);
          expect(await readFile(leasePath, "utf8")).toBe(successorLease);
          return;
        }
        await vi.advanceTimersByTimeAsync(40_000);
        await vi.waitFor(async () => {
          const lease = JSON.parse(await readFile(leasePath, "utf8")) as { expiresAt: string };
          expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now());
        });
        expect(await sessions.claimLease(session.sessionId, "competitor", 30_000)).toBe(false);
        failing = false;
        await release();
        expect(await session.getState()).toEqual(original);
        await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fetch(registrations[1]!.url)).rejects.toThrow();
        return;
      }
      if (outcome === "release waiting admission") {
        const getState = session.getState.bind(session);
        vi.spyOn(session, "getState").mockImplementationOnce(async () => {
          await releaseGate;
          return await getState();
        });
        const admitting = session.prompt("admitted before release");
        const rejectedAdmission = expect(admitting).rejects.toThrow();
        const releasing = session.releaseAfterTerminal();
        await session.close();
        completeRelease();
        await rejectedAdmission;
        await releasing;
        expect((await session.getState()).status).toBe("closed");
        expect(nativeClose).toHaveBeenCalledTimes(2);
        return;
      }
      const previouslyReleased = outcome.startsWith("released");
      if (previouslyReleased) {
        const before = await session.getState();
        if (outcome === "released checkpoint") await session.releaseAfterHumanCheckpoint();
        else await session.releaseAfterTerminal();
        const released = await session.getState();
        expect(released.status).toBe("open");
        expect(released.contexts).toEqual(before.contexts);
        const leasePath = new PragmaPaths({ pragmaHome: home }).expertSessionLease(
          session.sessionId,
        );
        await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
        if (outcome === "released owner taken") {
          const competingStore = createFileExpertSessionStore({ pragmaHome: home, executions });
          expect(await competingStore.claimLease(session.sessionId, "successor", 30_000)).toBe(
            true,
          );
          const successorLease = await readFile(leasePath, "utf8");
          await expect(session.close()).rejects.toThrow("active in another process");
          expect(await session.getState()).toEqual(released);
          expect(await readFile(leasePath, "utf8")).toBe(successorLease);
          expect(nativeClose).toHaveBeenCalledTimes(2);
          return;
        }
      }
      if (
        previouslyReleased ||
        outcome === "success" ||
        outcome === "pending close" ||
        outcome === "pending release"
      ) {
        const releasing =
          outcome === "pending release"
            ? session.releaseAfterTerminal({ settlement: releaseGate })
            : undefined;
        const closing = session.close();
        if (outcome === "pending close") {
          await vi.waitFor(() => expect(nativeClose).toHaveBeenCalledTimes(2));
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
          completeStop();
        }
        await closing;
        completeRelease();
        await releasing;
        await session.close();
        expect((await session.getState()).status).toBe("closed");
        expect(afterDestroy).toHaveBeenCalledTimes(2);
      } else {
        await expect(session.close()).rejects.toThrow(
          nativeFailure
            ? "native stop failed"
            : outcome === "cleanup failure"
              ? "cleanup failed"
              : "close persistence failed",
        );
        if (outcome === "persistence and read failure")
          await expect(session.getState()).rejects.toThrow("state read failed");
        const state = await session.getState();
        expect(state.status).toBe("open");
        expect(state.contexts[state.rootContextId]!.lifecycle).not.toBe("closed");
      }
      expect(nativeClose).toHaveBeenCalledTimes(2);
      if (nativeFailure) {
        // Unconfirmed stop retains resources; owner deletion still controls
        // when its separate cleanup phase may run.
        expect((await fetch(registrations[1]!.url)).status).not.toBe(404);
        expect(afterDestroy).toHaveBeenCalledOnce();
      } else {
        await expect(fetch(registrations[1]!.url)).rejects.toThrow();
      }
      if (
        !previouslyReleased &&
        outcome !== "success" &&
        outcome !== "pending close" &&
        outcome !== "pending release"
      ) {
        await expect(
          access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId)),
        ).resolves.toBeUndefined();
        const leasePath = new PragmaPaths({ pragmaHome: home }).expertSessionLease(
          session.sessionId,
        );
        const competingStore = createFileExpertSessionStore({
          pragmaHome: home,
          executions,
        });
        if (outcome === "lease lost") {
          // Model a heartbeat delayed by sleep: takeover is atomic in the real store.
          vi.setSystemTime(Date.now() + 40_000);
          expect(await competingStore.claimLease(session.sessionId, "successor", 30_000)).toBe(
            true,
          );
          const successorState = await session.getState();
          const successorLease = await readFile(leasePath, "utf8");
          failing = false;
          await expect(session.close()).rejects.toThrow("lease is no longer owned");
          expect(nativeClose).toHaveBeenCalledTimes(2);
          expect(afterDestroy).toHaveBeenCalledOnce();
          expect(await session.getState()).toEqual(successorState);
          expect(await readFile(leasePath, "utf8")).toBe(successorLease);
          return;
        }
        // Failed cleanup must keep the owner alive beyond the original 30s lease.
        await vi.advanceTimersByTimeAsync(40_000);
        await vi.waitFor(async () => {
          const lease = JSON.parse(await readFile(leasePath, "utf8")) as { expiresAt: string };
          expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now());
        });
        expect(await competingStore.claimLease(session.sessionId, "successor", 30_000)).toBe(false);
        failing = false;
        if (nativeFailure) await session.releaseAfterTerminal();
        else await session.releaseAfterHumanCheckpoint();
        expect((await session.getState()).status).toBe("closed");
        await expect(
          access(new PragmaPaths({ pragmaHome: home }).expertSessionLease(session.sessionId)),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fetch(registrations[1]!.url)).rejects.toThrow();
        await session.close();
      }
    } finally {
      completeRelease();
      completeStop();
      failing = false;
      await session.close().catch(() => undefined);
      await Promise.all(registrations.map((registration) => registration.dispose()));
      session.freezeForDeletion();
      vi.useRealTimers();
      await pool.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
