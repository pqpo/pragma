import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileExpertSessionStore,
  createNoopLoggerProvider,
  type ExpertSession,
} from "@pragma/core";
import { createLocalHostMissionCommandAdmission } from "../src/mission-command-admission.ts";
import { createLocalHostMissionMemoryLifecycle } from "../src/mission-memory-lifecycle.ts";
import { createMissionExecutionKernel } from "../src/missions/execution-kernel.ts";
import { MissionExecutionOwner } from "../src/missions/execution-owner.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  planes: [] as { closed: boolean; flush: ReturnType<typeof vi.fn> }[],
  stopMission: vi.fn<(missionId: string) => Promise<void>>(async () => undefined),
  stop: vi.fn(async () => undefined),
  policyFailure: false,
  conversationState: vi.fn<(input: unknown) => Promise<void>>(async () => undefined),
}));
vi.mock("../src/memory-data-plane.ts", () => ({
  createLocalHostMemoryDataPlane: async () => {
    const plane = {
      closed: false,
      flush: vi.fn(async () => {
        if (plane.closed) throw new Error("closed database");
      }),
    };
    fixtures.planes.push(plane);
    const close = () => {
      plane.closed = true;
    };
    return {
      policies: {
        getGlobal: async () => {
          if (fixtures.policyFailure) throw new Error("corrupt policy");
          return { policy: { enabled: "enabled" } };
        },
      },
      registerExecutionContext: async () => undefined,
      setConversationState: fixtures.conversationState,
      flushDelivery: plane.flush,
      scheduler: { stop: async () => undefined },
      episodic: { close },
      semantic: { close },
      knowledge: { close },
      skill: { close },
    };
  },
}));
vi.mock("../src/memory-context.ts", () => ({
  createLocalHostMemoryContextService: () => ({
    createContextStore: () => ({}),
    stopMission: fixtures.stopMission,
    stop: fixtures.stop,
  }),
}));
import { createLocalHostRunMemory } from "../src/run-memory.ts";

beforeEach(() => {
  fixtures.planes.length = 0;
  fixtures.policyFailure = false;
  fixtures.stopMission.mockReset().mockResolvedValue(undefined);
  fixtures.stop.mockReset().mockResolvedValue(undefined);
  fixtures.conversationState.mockClear();
});

describe("shared Host Mission Memory lifecycle", () => {
  it("opens the real canonical worker with logger and close callbacks kept in the Host", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-run-memory-worker-"));
    const beforeFeedClose = vi.fn(async () => undefined);
    const memory = createLocalHostRunMemory({
      pragmaHome: home,
      loggerProvider: createNoopLoggerProvider(),
      beforeFeedClose,
    });
    try {
      await expect(memory.canonical.inspect()).resolves.toBeDefined();
      await memory.close();
      expect(beforeFeedClose).toHaveBeenCalledOnce();
    } finally {
      await memory.close();
      await rm(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  it.each(["first", "new-execution"])(
    "lets a recovered owner %s bind and register while old attention teardown is blocked",
    async (nextExecutionId) => {
      const memory = createLocalHostRunMemory({ pragmaHome: "/unused-memory-lifetime-fixture" });
      await memory.bindings({ missionId: "first", goal: "first" });
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      fixtures.stopMission.mockImplementationOnce(async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const completion = memory.complete("first", "first");
      await started;
      const closing = memory.close();
      await memory.resume("first", nextExecutionId);
      const newOwner = memory.bindings({
        missionId: "first",
        goal: "second",
        bindingId: "first",
      });
      await newOwner;
      await memory.register({ missionId: "first", executionId: nextExecutionId });
      expect(fixtures.planes[0]?.closed).toBe(false);
      expect(fixtures.conversationState).toHaveBeenLastCalledWith({
        missionId: "first",
        state: "running",
      });
      release();
      await Promise.all([completion, closing, newOwner]);
      expect(fixtures.conversationState).toHaveBeenLastCalledWith({
        missionId: "first",
        state: "running",
      });
      expect(fixtures.planes[0]?.flush).toHaveBeenCalledOnce();
      expect(fixtures.planes).toHaveLength(1);
      expect(fixtures.planes[0]?.closed).toBe(false);
      await memory.close();
      expect(fixtures.planes[0]?.closed).toBe(false);
      await memory.complete("first", nextExecutionId);
      await memory.close();
      expect(fixtures.planes[0]?.closed).toBe(true);
    },
  );
  it("closes Usage only after the final concurrent owner releases", async () => {
    const beforeFeedClose = vi.fn(async () => undefined);
    const memory = createLocalHostRunMemory({
      pragmaHome: "/unused-memory-lifetime-fixture",
      beforeFeedClose,
    });
    await memory.bindings({ missionId: "first", goal: "first" });
    await memory.bindings({ missionId: "second", goal: "second" });
    await memory.complete("first", "first");
    await memory.close();
    expect(beforeFeedClose).not.toHaveBeenCalled();
    await memory.complete("second", "second");
    await memory.close();
    expect(beforeFeedClose).toHaveBeenCalledOnce();
  });
  it("keeps a waiting checkpoint active and reactivates its actual Execution after idle pause", async () => {
    const memory = createLocalHostRunMemory({ pragmaHome: "/unused-memory-lifetime-fixture" });
    await memory.bindings({ missionId: "mission", goal: "approval", bindingId: "context" });
    await memory.register({ missionId: "mission", executionId: "execution" });
    await memory.complete("mission", "execution", true);
    expect(fixtures.conversationState).toHaveBeenLastCalledWith({
      missionId: "mission",
      state: "active",
    });
    await memory.pause();
    expect(fixtures.planes[0]?.closed).toBe(true);
    await memory.resume("mission", "execution");
    await memory.bindings({ missionId: "mission", goal: "approval", bindingId: "context" });
    expect(fixtures.conversationState).toHaveBeenLastCalledWith({
      missionId: "mission",
      state: "running",
    });
    await memory.complete("mission", "execution");
    await memory.close();
    expect(fixtures.planes).toHaveLength(2);
    expect(fixtures.planes[1]?.closed).toBe(true);
  });
  it("retains the completion resource barrier through flush without blocking new bindings or registration", async () => {
    const beforeFeedClose = vi.fn(async () => undefined);
    const memory = createLocalHostRunMemory({
      pragmaHome: "/unused-memory-lifetime-fixture",
      beforeFeedClose,
    });
    await memory.bindings({ missionId: "mission", goal: "first", bindingId: "context" });
    await memory.register({ missionId: "mission", executionId: "first" });
    let releaseFlush!: () => void;
    fixtures.planes[0]!.flush.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );
    const completion = memory.complete("mission", "first");
    await vi.waitFor(() => expect(fixtures.planes[0]!.flush).toHaveBeenCalledOnce());
    await memory.pause();
    await memory.close();
    expect(fixtures.planes[0]?.closed).toBe(false);
    expect(beforeFeedClose).not.toHaveBeenCalled();
    await memory.beginPrompt("mission", "request-2");
    await memory.register({ missionId: "mission", executionId: "second" });
    // A lazy resolver can first bind the new Context after accepted registration.
    await memory.bindings({ missionId: "mission", goal: "second", bindingId: "new-context" });
    releaseFlush();
    await completion;
    await memory.complete("mission", "second");
    expect(fixtures.conversationState).toHaveBeenLastCalledWith({
      missionId: "mission",
      state: "completed",
    });
    await memory.close();
    expect(beforeFeedClose).toHaveBeenCalledOnce();
  });
  it.each(["accepted", "rejected"])(
    "reconciles an ownerless durable checkpoint across a %s prompt without installing an active owner",
    async (outcome) => {
      let releaseStop!: () => void;
      const stop = vi.fn(async () => undefined);
      stop.mockImplementationOnce(
        async () =>
          await new Promise<void>((resolve) => {
            releaseStop = resolve;
          }),
      );
      const state = vi.fn<(input: unknown) => Promise<void>>(async () => undefined);
      const close = vi.fn(async () => undefined);
      const memory = createLocalHostMissionMemoryLifecycle({
        ports: {
          bindings: async () => [],
          register: async () => undefined,
          setConversationState: state,
          stopMission: stop,
          close,
        },
      });
      // A checked cold delivery has a durable Execution but no live Memory owner.
      const reconciled = memory.reconcile("mission", "durable", true);
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      await memory.close();
      expect(close).not.toHaveBeenCalled();
      const rollback = await memory.beginPrompt("mission", "new-request");
      releaseStop();
      await reconciled;
      expect(state).not.toHaveBeenCalled();
      if (outcome === "accepted") {
        await memory.register({ missionId: "mission", executionId: "new-execution" });
        await rollback();
        expect(state).toHaveBeenLastCalledWith({ missionId: "mission", state: "running" });
        await memory.complete("mission", "new-execution");
        expect(state).toHaveBeenLastCalledWith({ missionId: "mission", state: "completed" });
      } else {
        await rollback();
        await vi.waitFor(() =>
          expect(state).toHaveBeenLastCalledWith({ missionId: "mission", state: "active" }),
        );
      }
      await vi.waitFor(async () => {
        await memory.close();
        expect(close).toHaveBeenCalledOnce();
      });
      expect(stop).toHaveBeenCalledTimes(2);
    },
  );
  it("reserves a pending binding and releases first-admission resources without blocking a successor", async () => {
    let finishBinding!: () => void;
    let finishStop!: () => void;
    const bind = vi.fn(
      async () =>
        await new Promise<never[]>((resolve) => {
          finishBinding = () => resolve([]);
        }),
    );
    const stop = vi.fn(async () => undefined);
    stop.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const close = vi.fn(async () => undefined);
    const state = vi.fn<(input: unknown) => Promise<void>>(async () => undefined);
    const memory = createLocalHostMissionMemoryLifecycle({
      ports: {
        bindings: bind,
        register: async () => undefined,
        stopMission: stop,
        setConversationState: state,
        close,
      },
    });
    const binding = memory.bindings({ missionId: "mission", goal: "first", bindingId: "scope" });
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce());
    const closing = memory.close();
    expect(close).not.toHaveBeenCalled();
    finishBinding();
    await Promise.all([binding, closing]);
    expect(close).not.toHaveBeenCalled();
    const rollback = await memory.beginPrompt("mission", "rejected-request");
    await rollback();
    await memory.close();
    expect(close).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    await memory.beginPrompt("mission", "accepted-request");
    await memory.register({ missionId: "mission", executionId: "actual" });
    expect(state).toHaveBeenLastCalledWith({ missionId: "mission", state: "running" });
    finishStop();
    await memory.complete("mission", "actual");
    await vi.waitFor(async () => {
      await memory.close();
      expect(close).toHaveBeenCalledOnce();
    });
  });
  it("ignores an old Execution terminal after a successor registers and retains repeated bindings", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-memory-late-terminal-"));
    const memory = createLocalHostRunMemory({ pragmaHome: home });
    try {
      await memory.bindings({ missionId: "mission", goal: "first", bindingId: "context-1" });
      await memory.register({ missionId: "mission", executionId: "execution-1" });
      await memory.beginPrompt("mission", "request-2");
      await memory.bindings({ missionId: "mission", goal: "second", bindingId: "context-2" });
      fixtures.stopMission.mockClear();
      fixtures.conversationState.mockClear();
      await memory.complete("mission", "execution-1");
      expect(fixtures.stopMission).not.toHaveBeenCalled();
      expect(fixtures.conversationState).not.toHaveBeenCalled();
      await memory.register({ missionId: "mission", executionId: "execution-2" });
      await memory.bindings({ missionId: "mission", goal: "second", bindingId: "context-2" });
      fixtures.stopMission.mockClear();
      fixtures.conversationState.mockClear();
      await memory.complete("mission", "execution-1");
      await memory.pause();
      expect(fixtures.stopMission).not.toHaveBeenCalled();
      expect(fixtures.conversationState).not.toHaveBeenCalled();
      expect(fixtures.planes[0]?.closed).toBe(false);
      await memory.complete("mission", "execution-2");
      expect(fixtures.stopMission).toHaveBeenCalledExactlyOnceWith("mission");
      expect(fixtures.conversationState).toHaveBeenCalledExactlyOnceWith({
        missionId: "mission",
        state: "completed",
      });
      await memory.pause();
      expect(fixtures.planes[0]?.closed).toBe(true);
    } finally {
      await memory.complete("mission", "execution-2");
      await memory.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["after-rejection", "during-intent", "stop-before-intent", "first-prompt-rejection"])(
    "rolls back a rejected actual prompt intent (old terminal arrived: %s)",
    async (timing) => {
      const terminalDuringIntent = timing === "during-intent";
      const stopBeforeIntent = timing === "stop-before-intent";
      const firstPromptRejection = timing === "first-prompt-rejection";
      const home = await mkdtemp(join(tmpdir(), "pragma-memory-rollback-"));
      const beforeFeedClose = vi.fn(async () => undefined);
      const memory = createLocalHostRunMemory({ pragmaHome: home, beforeFeedClose });
      let rejectPrompt!: (error: Error) => void;
      const prompt = vi.fn(
        async () =>
          await new Promise<never>((_resolve, reject) => {
            rejectPrompt = reject;
          }),
      );
      const session = { prompt, getPromptQueue: async () => [] } as unknown as ExpertSession;
      const admission = createLocalHostMissionCommandAdmission({
        executionKernel: createMissionExecutionKernel({
          executions: memory.executionStore,
          sessions: createFileExpertSessionStore({
            pragmaHome: home,
            executions: memory.executionStore,
          }),
          owners: new MissionExecutionOwner(),
        }),
        getMission: async () => ({
          id: "mission",
          lifecycleStatus: "active",
          executor: { kind: "expert" },
          execution: true,
        }),
        admit: async (_id, operation) => await operation(),
        withController: async (_id, operation) => await operation(),
        settleTerminal: async () => false,
        contextBindingsChanging: () => false,
        successorRequired: () => false,
        hasActive: () => true,
        session: () => session,
        assertReady: async () => undefined,
        startInitialRun: async () => undefined,
        prepare: async (_mission, input) => ({
          session,
          subject: {
            missionId: input.id,
            intent: "continue" as const,
            request: { requestId: input.requestId, prompt: input.content },
          },
          definitionChanged: false,
          contextStoresChanged: false,
          rememberSession: () => undefined,
        }),
        forgetSession: () => undefined,
        projectAccepted: async () => undefined,
        onPromptAdmitting: (id, requestId) => memory.beginPrompt(id, requestId),
      });
      try {
        await memory.bindings({ missionId: "mission", goal: "first", bindingId: "stable-context" });
        if (!firstPromptRejection)
          await memory.register({ missionId: "mission", executionId: "first" });
        else {
          await memory.close();
          expect(beforeFeedClose).not.toHaveBeenCalled();
        }
        const statesBeforeIntent = fixtures.conversationState.mock.calls.length;
        let releaseOldStop: (() => void) | undefined;
        if (terminalDuringIntent || stopBeforeIntent)
          fixtures.stopMission.mockImplementationOnce(
            async () =>
              await new Promise<void>((resolve) => {
                releaseOldStop = resolve;
              }),
          );
        const oldCompletion = stopBeforeIntent ? memory.complete("mission", "first") : undefined;
        if (stopBeforeIntent)
          await vi.waitFor(() => expect(fixtures.stopMission).toHaveBeenCalledOnce());
        const accepted = admission({ id: "mission", requestId: "second", content: "second" });
        const rejected = expect(accepted).rejects.toThrow("Core rejected");
        await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
        expect(fixtures.conversationState.mock.calls).toHaveLength(statesBeforeIntent);
        if (terminalDuringIntent) await memory.complete("mission", "first");
        if (stopBeforeIntent) {
          releaseOldStop!();
          await oldCompletion;
        }
        rejectPrompt(new Error("Core rejected"));
        await rejected;
        if (!terminalDuringIntent && !stopBeforeIntent && !firstPromptRejection)
          await memory.complete("mission", "first");
        if (firstPromptRejection) expect(fixtures.conversationState).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(fixtures.stopMission).toHaveBeenCalledTimes(stopBeforeIntent ? 2 : 1),
        );
        if (terminalDuringIntent) {
          await memory.beginPrompt("mission", "third");
          await memory.bindings({
            missionId: "mission",
            goal: "third",
            bindingId: "stable-context",
          });
          await memory.register({ missionId: "mission", executionId: "third" });
          releaseOldStop!();
          await memory.complete("mission", "third");
        }
        await vi.waitFor(async () => {
          await memory.close();
          expect(beforeFeedClose).toHaveBeenCalled();
        });
      } finally {
        await memory.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("isolates optional Memory initialization and delivery failures from execution", async () => {
    const memory = createLocalHostRunMemory({ pragmaHome: "/unused-memory-lifetime-fixture" });
    fixtures.policyFailure = true;
    await expect(memory.bindings({ missionId: "first", goal: "first" })).resolves.toEqual([]);
    fixtures.stopMission.mockRejectedValueOnce(new Error("unavailable observer"));
    await expect(memory.complete("first", "first")).resolves.toBeUndefined();
    fixtures.stop.mockRejectedValueOnce(new Error("observer shutdown failed"));
    await expect(memory.close()).resolves.toBeUndefined();
    expect(fixtures.planes[0]?.closed).toBe(true);
  });
});
