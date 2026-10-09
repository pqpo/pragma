import { describe, expect, it, vi } from "vitest";
import type { DurableExecutionStore } from "@pragma/core";
import type { Mission } from "@pragma/shared";
import type { MissionOwnerScope } from "../src/missions/controller/owner-scope.ts";
import type { MissionStore } from "../src/missions/repository/mission-store.ts";
import { createMissionTerminalMaterializer } from "../src/missions/mission-terminal-materializer.ts";

// Durable receipt retry/claim/history ordering is covered by mission-delivery.test.ts.
// These checks cover the shared materialization boundary for both compositions.
function fixture(ownerLifetime: "host" | "request" = "host", hasGuard = true) {
  const mission = {
    id: "mission",
    execution: { id: "execution", sessionId: "session" },
  } as Mission;
  const guard = { ownerId: "owner" };
  const release = vi.fn(async () => undefined);
  const withAdmission = vi.fn(
    async (_id: string, operation: () => Promise<void>) => await operation(),
  );
  const updateExecution = vi.fn(async () => undefined);
  const archive = vi.fn(async () => undefined);
  const terminal = vi.fn(async () => undefined);
  const memory = vi.fn(async () => undefined);
  const get = vi.fn(async () => ({
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:01:00.000Z",
    output: { type: "inline", value: "answer" },
  }));
  const materialize = createMissionTerminalMaterializer({
    ownerLifetime,
    withAdmission,
    ownerScope: {
      acquire: async () => guard,
      currentGuard: () => (hasGuard ? guard : undefined),
      release,
      runWithoutGuard: async (operation: () => Promise<void>) => await operation(),
      runWithGuard: async (_id: string, _guard: unknown, operation: () => Promise<void>) =>
        await operation(),
    } as unknown as MissionOwnerScope,
    missions: { get: async () => mission, updateExecution } as unknown as MissionStore,
    executions: { get, archive } as unknown as DurableExecutionStore,
    projector: { terminal, link: async () => undefined },
    memory,
  });
  return {
    mission,
    materialize,
    guard,
    updateExecution,
    archive,
    terminal,
    memory,
    get,
    release,
    withAdmission,
  };
}

describe("shared Mission terminal materialization", () => {
  it("projects the durable result under the original owner fence", async () => {
    const f = fixture();
    await f.materialize(f.mission, "execution", "request", "succeeded", "terminal");
    expect(f.terminal).toHaveBeenCalledWith({
      mission: f.mission,
      executionId: "execution",
      status: "succeeded",
      result: "answer",
      error: undefined,
      guard: f.guard,
    });
  });
  it("keeps original request/session identity and conditional metadata admission", async () => {
    const f = fixture();
    await f.materialize(f.mission, "execution", "request", "succeeded", "metadata");
    expect(f.updateExecution).toHaveBeenCalledWith(
      "mission",
      expect.objectContaining({
        id: "execution",
        inputMessageId: "request",
        sessionId: "session",
        status: "succeeded",
      }),
      { executionId: "execution", statuses: ["queued", "running", "waiting"] },
    );
  });
  it.each([false, true])(
    "serializes request custody and defers enrichment after its owner was released (existing=%s)",
    async (hasGuard) => {
      const f = fixture("request", hasGuard);
      const result = await f.materialize(
        f.mission,
        "execution",
        "request",
        "succeeded",
        "terminal",
      );
      expect(f.withAdmission).toHaveBeenCalledOnce();
      expect(result).toBe(hasGuard ? undefined : "deferred");
      expect(f.release).not.toHaveBeenCalled();
      expect(f.terminal).toHaveBeenCalledTimes(hasGuard ? 1 : 0);
    },
  );
  it("retains custody when the source execution is unavailable", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce(undefined as never);
    await expect(
      f.materialize(f.mission, "execution", "request", "succeeded", "archive"),
    ).rejects.toThrow("MISSION_DELIVERY_EXECUTION_UNAVAILABLE");
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.memory).not.toHaveBeenCalled();
  });
});
