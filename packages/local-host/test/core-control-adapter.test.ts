import type { ExpertSession, ExecutionStore, RuntimeResolver } from "@pragma/core";
import { MissionCommandSchema } from "@pragma/shared/integration";
import { describe, expect, it, vi } from "vitest";

import { createLocalHostCoreMissionControlAdapter } from "../src/index.ts";

describe("Local Host Core Mission control adapter", () => {
  it("waits for the Mission terminal commit after Core terminal", async () => {
    let commit: () => void = () => undefined;
    const durableTerminal = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const executionSettlement = vi.fn(() => durableTerminal);
    const adapter = createLocalHostCoreMissionControlAdapter({
      runtimes: {} as RuntimeResolver,
      executions: {
        get: async () => ({ executionId: "execution-1", status: "succeeded" }),
      } as unknown as ExecutionStore,
      sessions: {} as never,
      mission: { controller: {} as never, append: async () => undefined },
      executors: [],
      resolveMissionBinding: async () => undefined,
      executionSettlement,
    });
    let returned = false;
    const outcome = adapter
      .waitExecution({ missionId: "mission-1", executionId: "execution-1" })
      .then((value) => {
        returned = true;
        return value;
      });
    await vi.waitFor(() => expect(executionSettlement).toHaveBeenCalledWith("mission-1"));
    expect(returned).toBe(false);
    commit();
    await expect(outcome).resolves.toMatchObject({
      executionId: "execution-1",
      status: "succeeded",
    });
  });

  it("forwards durable command attachments and explicit queue recovery to Core", async () => {
    const prompt = vi.fn(async (_content: string, options: unknown) => ({
      executionId: "execution-1",
      requestId: "00000000-0000-4000-8000-000000000002",
      options,
    }));
    const resumePromptQueue = vi.fn(async () => undefined);
    const onExecutionAccepted = vi.fn(async () => undefined);
    const onPromptAdmitting = vi.fn(async () => undefined);
    const session = {
      prompt,
      resumePromptQueue,
      getPromptQueue: async () => [],
      getPromptQueueState: async () => ({ state: "idle", pendingCount: 0 }),
    } as unknown as ExpertSession;
    const executions = {
      get: async () => undefined,
    } as unknown as ExecutionStore;
    const adapter = createLocalHostCoreMissionControlAdapter({
      runtimes: {} as RuntimeResolver,
      executions,
      sessions: { get: async () => undefined } as never,
      mission: { controller: {} as never, append: async () => undefined },
      executors: [],
      resolveMissionBinding: async () => undefined,
      onExecutionAccepted,
      onPromptAdmitting,
      resolveActiveOwner: async () => ({
        kind: "session",
        session,
        executor: {} as never,
      }),
    });
    const attachment = {
      id: "00000000-0000-4000-8000-000000000003",
      kind: "file" as const,
      name: "notes.txt",
      path: "/workspace/notes.txt",
      mimeType: "text/plain",
      size: 12,
    };
    const command = MissionCommandSchema.parse({
      schemaVersion: "pragma.mission-command/v2",
      commandId: "00000000-0000-4000-8000-000000000004",
      request: {
        schemaVersion: "pragma.integration-request/v1",
        requestId: "00000000-0000-4000-8000-000000000002",
        payloadHash: `sha256:${"a".repeat(64)}`,
        requestedAt: "2026-08-31T00:00:00.000Z",
        client: {
          surface: "desktop",
          version: "test",
          instanceId: "00000000-0000-4000-8000-000000000005",
        },
      },
      missionId: "00000000-0000-4000-8000-000000000001",
      kind: "send",
      payload: { kind: "send", input: { prompt: "Read this", attachments: [attachment] } },
      state: "accepted",
      createdAt: "2026-08-31T00:00:00.000Z",
    });

    await adapter.consumer.apply({
      signal: new AbortController().signal,
      deadlineAt: "2026-10-02T01:00:00.000Z",
      command,
      guard: {
        claimId: "00000000-0000-4000-8000-000000000006",
        fencingToken: "1",
      },
    });

    expect(prompt).toHaveBeenCalledWith("Read this", {
      requestId: command.request.requestId,
      mode: "enqueue",
      attachments: [attachment],
    });
    expect(onPromptAdmitting).toHaveBeenCalledExactlyOnceWith(
      command.missionId,
      command.request.requestId,
    );
    expect(onExecutionAccepted).toHaveBeenCalledExactlyOnceWith({
      missionId: command.missionId,
      executionId: "execution-1",
    });
    for (const recovery of [undefined, "abandon"] as const) {
      await adapter.consumer.apply({
        signal: new AbortController().signal,
        deadlineAt: "2026-10-02T01:00:00.000Z",
        command: MissionCommandSchema.parse({
          ...command,
          kind: "queue.resume",
          payload: { kind: "queue.resume", ...(recovery === undefined ? {} : { recovery }) },
        }),
        guard: { claimId: "00000000-0000-4000-8000-000000000006", fencingToken: "1" },
      });
      expect(resumePromptQueue).toHaveBeenLastCalledWith({ recovery });
    }
  });
});
