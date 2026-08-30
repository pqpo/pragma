import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExecutionRecord, Invocation } from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFileExecutionStore,
  type ExecutionStore,
  type ExpertAgentHumanRequest,
  type RuntimeAgentSession,
  type RuntimeSubmitHandle,
} from "../src/index.ts";
import {
  ExecutionController,
  HumanInteractionCheckpointError,
} from "../src/execution/expert-runner.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("human interaction checkpoint", () => {
  it("checkpoints only a durably waiting interaction and releases its recovery claim", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-human-checkpoint-"));
    roots.push(home);
    const store = createFileExecutionStore({ pragmaHome: home });
    const { executionId, invocationId } = await createFixture(store);
    const controller = new ExecutionController(executionId, store);
    const request = {
      kind: "tool_approval",
      toolName: "write_file",
      toolCallId: "tool-call",
      reason: "Write a file",
      input: { path: "out.txt" },
    } satisfies ExpertAgentHumanRequest;
    const pending = controller
      .requestHumanInteraction(invocationId, request, "interaction-1")
      .catch((error: unknown) => error);
    await waitForEvent(store, executionId, "human.waiting");

    await expect(controller.checkpointWaitingHuman()).resolves.toBeUndefined();
    await expect(pending).resolves.toBeInstanceOf(HumanInteractionCheckpointError);
    await expect(store.get(executionId)).resolves.toMatchObject({ status: "waiting" });

    await expect(store.claimRecovery(executionId, "recovery-owner", 30_000)).resolves.toBe(true);
    await expect(
      store.releaseWaitingHumanRecovery(executionId, "recovery-owner"),
    ).resolves.toBeUndefined();
    await expect(store.get(executionId)).resolves.toMatchObject({ state: {} });
  });

  it("revalidates and retries when a same-owner renewal bumps the execution version", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-human-checkpoint-race-"));
    roots.push(home);
    const store = createFileExecutionStore({ pragmaHome: home });
    const { executionId, invocationId } = await createFixture(store);
    const controller = new ExecutionController(executionId, store);
    const pending = controller
      .requestHumanInteraction(
        invocationId,
        {
          kind: "tool_approval",
          toolName: "write_file",
          toolCallId: "tool-call-race",
          reason: "Write a file",
          input: { path: "out.txt" },
        },
        "interaction-race",
      )
      .catch((error: unknown) => error);
    await waitForEvent(store, executionId, "human.waiting");
    await expect(controller.checkpointWaitingHuman()).resolves.toBeUndefined();
    await expect(pending).resolves.toBeInstanceOf(HumanInteractionCheckpointError);

    const claimId = "recovery-owner-race";
    await expect(store.claimRecovery(executionId, claimId, 30_000)).resolves.toBe(true);
    let conflictInjected = false;
    const racingStore: ExecutionStore = {
      ...store,
      async commit(request) {
        if (!conflictInjected && request.commitId === `release-waiting-human-recovery:${claimId}`) {
          conflictInjected = true;
          await store.claimRecovery(executionId, claimId, 30_000);
        }
        return await store.commit(request);
      },
    };

    await expect(
      racingStore.releaseWaitingHumanRecovery(executionId, claimId),
    ).resolves.toBeUndefined();
    expect(conflictInjected).toBe(true);
    await expect(store.get(executionId)).resolves.toMatchObject({ state: {} });
  });

  it("stops the active Runtime submission and records a checkpoint fence", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-human-checkpoint-runtime-"));
    roots.push(home);
    const store = createFileExecutionStore({ pragmaHome: home });
    const { executionId, invocationId } = await createFixture(store);
    const controller = new ExecutionController(executionId, store);
    const cancel = vi.fn(async () => undefined);
    const handle = {
      runId: "runtime-run",
      events: [],
      result: Promise.resolve({ runId: "runtime-run", result: { output: "late" } }),
      cancel,
    } as unknown as RuntimeSubmitHandle;
    controller.registerRuntimeSubmission(
      invocationId,
      "checkpoint-context",
      {} as RuntimeAgentSession,
      handle,
      false,
    );
    const pending = controller
      .requestHumanInteraction(
        invocationId,
        {
          kind: "tool_approval",
          toolName: "write_file",
          toolCallId: "tool-call-runtime",
          reason: "Write a file",
          input: { path: "out.txt" },
        },
        "interaction-runtime",
      )
      .catch((error: unknown) => error);
    await waitForEvent(store, executionId, "human.waiting");

    await expect(controller.checkpointWaitingHuman()).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBeInstanceOf(HumanInteractionCheckpointError);
    expect(controller.getHumanInteractionCheckpoint(invocationId)).toBeInstanceOf(
      HumanInteractionCheckpointError,
    );
    await expect(store.get(executionId)).resolves.toMatchObject({ status: "waiting" });
  });
});

async function createFixture(store: ExecutionStore): Promise<{
  readonly executionId: string;
  readonly invocationId: string;
}> {
  const executionId = "33333333-3333-4333-8333-333333333333";
  const invocationId = executionId;
  const timestamp = new Date().toISOString();
  const definition = { id: "checkpoint-expert", kind: "expert" as const };
  const execution: ExecutionRecord = {
    schemaVersion: "pragma.execution/v10",
    executionId,
    version: 0,
    kind: "expert-turn",
    definition,
    rootInvocationId: invocationId,
    status: "running",
    input: "hello",
    state: {},
    lastAppliedSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const invocation: Invocation = {
    invocationId,
    rootInvocationId: invocationId,
    definition,
    executorId: definition.id,
    contextId: "checkpoint-context",
    status: "running",
    pendingExpertMessages: [],
    input: "hello",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.create(execution, invocation);
  return { executionId, invocationId };
}

async function waitForEvent(
  store: ExecutionStore,
  executionId: string,
  type: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await store.readEvents(executionId)).some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}.`);
}
