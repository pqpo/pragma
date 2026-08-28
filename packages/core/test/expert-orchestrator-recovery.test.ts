import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { defineExpert } from "../src/agent/expert-agent.ts";
import { ExpertOrchestrator } from "../src/execution/expert-orchestrator.ts";
import { createFileExecutionStore } from "../src/execution/execution-store.ts";

const temporaryRoots: string[] = [];
const now = "2026-08-22T08:00:00.000Z";

afterEach(async () => {
  await waitForTemporaryRootsToQuiesce();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }),
  );
});

async function waitForTemporaryRootsToQuiesce(): Promise<void> {
  const deadline = Date.now() + 10_000;
  let quietSince: number | undefined;
  while (Date.now() < deadline) {
    let hasExecutionLock = false;
    for (const root of temporaryRoots) {
      try {
        const executions = await readdir(join(root, "state", "executions"), {
          withFileTypes: true,
        });
        for (const execution of executions) {
          if (!execution.isDirectory()) continue;
          const entries = await readdir(join(root, "state", "executions", execution.name), {
            withFileTypes: true,
          });
          if (
            entries.some(
              (entry) => entry.name === ".lock" || entry.name.startsWith(".lock.staging-"),
            )
          ) {
            hasExecutionLock = true;
            break;
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (hasExecutionLock) break;
    }
    if (!hasExecutionLock) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= 100) return;
    } else {
      quietSince = undefined;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for orchestrator recovery test resources to quiesce.");
}

describe("ExpertOrchestrator recovery", { timeout: 30_000 }, () => {
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
