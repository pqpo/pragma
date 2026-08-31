import type { ExpertSession, ExecutionStore, RuntimeResolver } from "@pragma/core";
import { MissionCommandSchema } from "@pragma/shared/integration";
import { describe, expect, it, vi } from "vitest";

import { createLocalHostCoreMissionControlAdapter } from "../src/index.ts";

describe("Local Host Core Mission control adapter", () => {
  it("forwards durable command attachments to the ExpertSession prompt", async () => {
    const prompt = vi.fn(async (_content: string, options: unknown) => ({
      executionId: "execution-1",
      requestId: "00000000-0000-4000-8000-000000000002",
      options,
    }));
    const session = {
      prompt,
      getPromptQueue: async () => [],
      getPromptQueueState: async () => ({ state: "idle", pendingCount: 0 }),
    } as unknown as ExpertSession;
    const executions = {
      get: async () => undefined,
    } as unknown as ExecutionStore;
    const adapter = createLocalHostCoreMissionControlAdapter({
      runtimes: {} as RuntimeResolver,
      executions,
      sessions: {} as never,
      mission: { controller: {} as never, append: async () => undefined },
      executors: [],
      resolveMissionBinding: async () => undefined,
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
  });
});
