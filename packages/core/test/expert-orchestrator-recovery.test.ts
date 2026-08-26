import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineExpert } from "../src/agent/expert-agent.ts";
import { DelegationSemaphore, ExpertOrchestrator } from "../src/execution/expert-orchestrator.ts";
import { createFileExecutionStore } from "../src/execution/execution-store.ts";

const temporaryRoots: string[] = [];
const now = "2026-08-22T08:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("ExpertOrchestrator recovery", () => {
  it("lets a timed-out waiter regain control without corrupting the concurrency queue", async () => {
    const semaphore = new DelegationSemaphore(1);
    const parent = await semaphore.acquire();
    const resumeParent = parent.suspend();
    if (resumeParent === undefined) throw new Error("Parent permit was not suspended.");
    const child = await semaphore.acquire();

    await resumeParent({ allowOvercommit: true });
    let queuedAcquired = false;
    const queuedPromise = semaphore.acquire().then((permit) => {
      queuedAcquired = true;
      return permit;
    });
    await Promise.resolve();
    expect(queuedAcquired).toBe(false);

    parent.release();
    await Promise.resolve();
    expect(queuedAcquired).toBe(false);

    child.release();
    const queued = await queuedPromise;
    expect(queuedAcquired).toBe(true);
    queued.release();
  });

  it("retains accepted messages until the delivered batch is acknowledged", async () => {
    const home = await temporaryRoot("pragma-message-handoff-");
    const store = createFileExecutionStore({ pragmaHome: home });
    const messages = [
      expertMessage("00000000-0000-4000-8000-000000000001", "first"),
      expertMessage("00000000-0000-4000-8000-000000000002", "second"),
    ];
    await store.create(executionRecord("message-execution"), {
      ...invocationRecord(),
      status: "running",
      pendingExpertMessages: messages,
    });
    const orchestrator = createOrchestrator(store, "message-execution");

    await expect(orchestrator.readPendingMessages("root")).resolves.toEqual(messages);
    await expect(store.getInvocation("message-execution", "root")).resolves.toMatchObject({
      pendingExpertMessages: messages,
    });

    await orchestrator.acknowledgePendingMessages("root", [messages[0]!.messageId]);

    await expect(store.getInvocation("message-execution", "root")).resolves.toMatchObject({
      pendingExpertMessages: [messages[1]],
    });
    await expect(store.readEvents("message-execution")).resolves.toEqual([
      expect.objectContaining({
        type: "expert.message.consumed",
        data: { messageIds: [messages[0]!.messageId] },
      }),
    ]);
  });

  it("rebinds a recovered active Invocation even after its original activation was committed", async () => {
    const home = await temporaryRoot("pragma-agent-reactivation-");
    const store = createFileExecutionStore({ pragmaHome: home });
    await store.create(executionRecord("recovery-execution"), {
      ...invocationRecord(),
      agentId: "agent",
      agentTaskSequence: 1,
    });
    await store.commit({
      commitId: "seed-recovery-agent",
      executionId: "recovery-execution",
      contextPuts: [runtimeContext("recovery-execution")],
      agentPuts: [agentRecord("recovery-execution")],
    });
    await store.commit({
      commitId: "agent-activated:root",
      executionId: "recovery-execution",
      agentPatches: [{ agentId: "agent", patch: { activeInvocationId: "root" } }],
      events: [{ invocationId: "root", type: "agent.task.activated", data: { agentId: "agent" } }],
    });

    let resolveExecuted!: () => void;
    const executed = new Promise<void>((resolve) => {
      resolveExecuted = resolve;
    });
    const orchestrator = createOrchestrator(store, "recovery-execution", async ({ agent }) => {
      expect(agent.activeInvocationId).toBe("root");
      await store.commit({
        commitId: "test-recovered-execution-completed",
        executionId: "recovery-execution",
        invocationPatches: [
          { invocationId: "root", patch: { status: "waiting", waitReason: "experts" } },
        ],
      });
      resolveExecuted();
    });
    const expert = await defineExpert({
      id: "worker",
      name: "Worker",
      description: "Worker",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });

    await orchestrator.registerExperts([expert]);
    await executed;
    await waitUntil(async () =>
      (await store.readEvents("recovery-execution")).some(
        (event) => event.type === "agent.task.released",
      ),
    );

    await expect(store.getInvocation("recovery-execution", "root")).resolves.toMatchObject({
      status: "waiting",
    });
    expect(
      (await store.readEvents("recovery-execution")).filter(
        (event) => event.type === "agent.task.activated",
      ),
    ).toHaveLength(2);
  });

  it("reports already_terminal when an interrupt loses the completion race", async () => {
    const home = await temporaryRoot("pragma-interrupt-race-");
    const store = createFileExecutionStore({ pragmaHome: home });
    await store.create(executionRecord("interrupt-race"), {
      ...invocationRecord(),
      status: "running",
      agentId: "agent",
      agentTaskSequence: 0,
    });
    await store.commit({
      commitId: "seed-interrupt-race",
      executionId: "interrupt-race",
      contextPuts: [runtimeContext("interrupt-race")],
      agentPuts: [{ ...agentRecord("interrupt-race"), activeInvocationId: "root" }],
    });
    const orchestrator = new ExpertOrchestrator({
      executionId: "interrupt-race",
      rootInvocationId: "root",
      scopeInvocationId: "root",
      store,
      maxConcurrency: 1,
      maxDepth: 3,
      interruptController: {
        interruptInvocation: async () => {
          await store.commit({
            commitId: "complete-before-interrupt",
            executionId: "interrupt-race",
            invocationPatches: [{ invocationId: "root", patch: { status: "cancelled" } }],
            agentPatches: [{ agentId: "agent", patch: { activeInvocationId: undefined } }],
          });
          return false;
        },
        signalForInvocation: () => new AbortController().signal,
        steerInvocation: async () => "not_active",
      },
      execute: async () => undefined,
    });

    await expect(
      orchestrator.interrupt(
        {
          ownerContextId: "coordinator-context",
          callerInvocationId: "coordinator",
          callerDepth: 0,
          spawnExpertIds: new Set(),
          interactExpertIds: new Set(),
          isCoordinator: true,
        },
        { invocationId: "root" },
      ),
    ).resolves.toMatchObject({ outcome: "already_terminal", invocationId: "root" });
  });

  it("reports the committed Agent disposition for concurrent historical continuations", async () => {
    const home = await temporaryRoot("pragma-concurrent-materialization-");
    const store = createFileExecutionStore({ pragmaHome: home });
    await store.create(executionRecord("continuation-execution"), {
      ...invocationRecord(),
      status: "running",
      contextId: "coordinator-context",
    });
    const historicalContext = {
      ...runtimeContext("team-session"),
      contextId: "historical-context",
    };
    const historicalAgent = {
      ...agentRecord("historical-execution"),
      agentId: "historical-agent",
      contextId: historicalContext.contextId,
      nextTaskSequence: 1,
    };
    const historicalInvocation = {
      ...invocationRecord(),
      invocationId: "historical-invocation",
      rootInvocationId: "historical-invocation",
      agentId: historicalAgent.agentId,
      agentTaskSequence: 0,
      contextId: historicalContext.contextId,
      status: "interrupted" as const,
    };
    let initialReaders = 0;
    let releaseInitialReaders!: () => void;
    const bothInitialReaders = new Promise<void>((resolve) => {
      releaseInitialReaders = resolve;
    });
    const readContextScope = async () => {
      initialReaders += 1;
      if (initialReaders <= 2) {
        if (initialReaders === 2) releaseInitialReaders();
        await bothInitialReaders;
      }
      return {
        contexts: [historicalContext],
        invocations: [historicalInvocation],
        agents: [historicalAgent],
      };
    };
    const orchestrator = new ExpertOrchestrator({
      executionId: "continuation-execution",
      rootInvocationId: "root",
      scopeInvocationId: "root",
      store,
      maxConcurrency: 1,
      maxDepth: 3,
      readContextScope,
      interruptController: {
        interruptInvocation: async () => false,
        signalForInvocation: () => new AbortController().signal,
        steerInvocation: async () => "not_active",
      },
      execute: async () => undefined,
    });
    const expert = await defineExpert({
      id: "worker",
      name: "Worker",
      description: "Worker",
      tags: [],
      scope: "test",
      workspace: home,
      pragmaHome: home,
    });
    await orchestrator.registerExperts([expert]);
    (orchestrator as unknown as { schedule(agentId: string): void }).schedule = () => undefined;
    const access = {
      ownerContextId: "coordinator-context",
      callerInvocationId: "root",
      callerDepth: 0,
      spawnExpertIds: new Set(["worker"]),
      interactExpertIds: new Set(["worker"]),
      isCoordinator: true,
    };

    const results = await Promise.all([
      orchestrator.continueContext(access, {
        contextId: historicalContext.contextId,
        task: "first",
      }),
      orchestrator.continueContext(access, {
        contextId: historicalContext.contextId,
        task: "second",
      }),
    ]);

    expect(results.map((result) => result.agentDisposition).sort()).toEqual([
      "materialized",
      "reused",
    ]);
    expect(new Set(results.map((result) => result.agentId)).size).toBe(1);
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function createOrchestrator(
  store: ReturnType<typeof createFileExecutionStore>,
  executionId: string,
  execute: ConstructorParameters<typeof ExpertOrchestrator>[0]["execute"] = async () => undefined,
): ExpertOrchestrator {
  return new ExpertOrchestrator({
    executionId,
    rootInvocationId: "root",
    scopeInvocationId: "root",
    store,
    maxConcurrency: 1,
    maxDepth: 3,
    interruptController: {
      interruptInvocation: async () => false,
      signalForInvocation: () => new AbortController().signal,
      steerInvocation: async () => "not_active",
    },
    execute,
  });
}

function executionRecord(executionId: string) {
  return {
    schemaVersion: "pragma.execution/v10" as const,
    executionId,
    version: 0,
    kind: "expert-turn" as const,
    definition: { id: "worker", kind: "expert" as const },
    rootInvocationId: "root",
    status: "running" as const,
    input: "work",
    state: {},
    lastAppliedSequence: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function invocationRecord() {
  return {
    invocationId: "root",
    rootInvocationId: "root",
    definition: { id: "worker", kind: "expert" as const },
    executorId: "worker",
    contextId: "context",
    status: "queued" as const,
    pendingExpertMessages: [],
    input: "work",
    createdAt: now,
    updatedAt: now,
  };
}

function expertMessage(messageId: string, content: string) {
  return {
    messageId,
    senderInvocationId: "sender",
    content,
    createdAt: now,
  };
}

function runtimeContext(executionId: string) {
  return {
    schemaVersion: "pragma.runtime-context/v5" as const,
    contextId: "context",
    owner: { type: "flow-execution" as const, ownerId: executionId },
    origin: { type: "invocation" as const, invocationId: "root" },
    expert: { id: "worker" },
    runtime: { runtimeId: "fake", revision: 1, fingerprint: "a".repeat(64) },
    lifecycle: "open" as const,
    createdAt: now,
    updatedAt: now,
  };
}

function agentRecord(executionId: string) {
  return {
    schemaVersion: "pragma.agent-instance/v2" as const,
    agentId: "agent",
    executionId,
    ownerContextId: "owner-context",
    createdByInvocationId: "root",
    definition: { id: "worker", kind: "expert" as const },
    contextId: "context",
    lifecycle: "open" as const,
    nextTaskSequence: 2,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
