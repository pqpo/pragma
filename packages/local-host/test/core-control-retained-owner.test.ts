import type {
  ExecutionStore,
  ExpertSession,
  ExpertSessionStore,
  RuntimeResolver,
} from "@pragma/core";
import { MissionCommandSchema } from "@pragma/shared/integration";
import { expect, it, vi } from "vitest";
import { createLocalHostCoreMissionControlAdapter, MissionExecutionOwner } from "../src/index.ts";

it("mutates a retained Session queue without probing storage using the Mission identity", async () => {
  const missionId = "00000000-0000-4000-8000-000000000001";
  const owners = new MissionExecutionOwner();
  const removeQueuedPrompt = vi.fn(async () => undefined);
  owners.setControlOwner(
    missionId,
    {
      kind: "session",
      session: {
        sessionId: "10000000-0000-4000-8000-000000000001",
        removeQueuedPrompt,
      } as unknown as ExpertSession,
    },
    "live",
  );
  const readExecution = vi.fn(async () => {
    throw new Error("Retained handle must not probe a Mission ID as an Execution ID.");
  });
  const recover = vi.fn(async () => {
    throw new Error("Retained handle must not recover.");
  });
  const control = createLocalHostCoreMissionControlAdapter({
    ownerAccess: owners,
    runtimes: {} as RuntimeResolver,
    executions: { get: readExecution } as unknown as ExecutionStore,
    sessions: {} as ExpertSessionStore,
    executors: [],
    resolveMissionBinding: async () => undefined,
    prepareRecoveryResources: recover,
  });
  const command = MissionCommandSchema.parse({
    schemaVersion: "pragma.mission-command/v2",
    commandId: "00000000-0000-4000-8000-000000000002",
    request: {
      schemaVersion: "pragma.integration-request/v1",
      requestId: "00000000-0000-4000-8000-000000000003",
      payloadHash: `sha256:${"a".repeat(64)}`,
      requestedAt: "2026-10-02T00:00:00.000Z",
      client: {
        surface: "desktop",
        version: "test",
        instanceId: "00000000-0000-4000-8000-000000000004",
      },
    },
    missionId,
    kind: "queue.remove",
    payload: { kind: "queue.remove", requestId: "00000000-0000-4000-8000-000000000005" },
    state: "accepted",
    createdAt: "2026-10-02T00:00:00.000Z",
  });
  await control.consumer.apply({
    command,
    guard: { claimId: "00000000-0000-4000-8000-000000000006", fencingToken: "1" },
    signal: new AbortController().signal,
    deadlineAt: "2026-10-02T01:00:00.000Z",
  });
  expect(removeQueuedPrompt).toHaveBeenCalledExactlyOnceWith(
    command.payload.kind === "queue.remove" ? command.payload.requestId : "",
  );
  expect(readExecution).not.toHaveBeenCalled();
  expect(recover).not.toHaveBeenCalled();
});
