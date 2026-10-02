import { describe, expect, it, vi } from "vitest";

import { MissionChatService } from "./mission-chat-service.ts";
import { MissionCommandService } from "./mission-command-service.ts";
import { MissionStatusService } from "./mission-status-service.ts";
import { MissionWorkService, type MissionWorkProjection } from "./mission-work-service.ts";

describe("Mission service state ownership", () => {
  it("publishes Mission status independently from chat and work revisions", () => {
    const listenerError = vi.fn();
    const listener = vi.fn();
    const service = new MissionStatusService(listenerError);
    service.subscribe(listener);

    service.publish("mission-1", "user", { id: "execution-1", status: "succeeded" });

    expect(listener).toHaveBeenCalledWith({
      missionId: "mission-1",
      audience: "user",
      revision: 1,
      execution: { id: "execution-1", status: "succeeded" },
    });
    service.publish("mission-1", "user", { id: "execution-1", status: "failed" });
    service.publish("mission-2", "user");
    expect(listener).toHaveBeenNthCalledWith(2, {
      missionId: "mission-1",
      audience: "user",
      revision: 2,
      execution: { id: "execution-1", status: "failed" },
    });
    expect(listener).toHaveBeenNthCalledWith(3, {
      missionId: "mission-2",
      audience: "user",
      revision: 1,
    });
    expect(listenerError).not.toHaveBeenCalled();
  });

  it("increments chat revisions and contains listener failures", () => {
    const listenerError = vi.fn();
    const service = new MissionChatService<{ close: () => Promise<void> }>(listenerError);
    const updates: number[] = [];
    const invalidations: unknown[] = [];
    service.subscribe(() => {
      throw new Error("listener failed");
    });
    service.subscribe(({ update }) => {
      updates.push(update.revision);
      if (update.kind === "invalidate") invalidations.push(update);
    });

    service.emitPatches("mission-1", "user", [
      { type: "entry.append", entryId: "entry-1", field: "content", delta: "hello" },
    ]);
    service.invalidate("mission-1", "user");
    service.invalidate("mission-1", "user", { userVisibleOutput: true });

    expect(updates).toEqual([1, 2, 3]);
    expect(invalidations).toEqual([
      expect.objectContaining({ missionId: "mission-1", revision: 2, kind: "invalidate" }),
      expect.objectContaining({
        missionId: "mission-1",
        revision: 3,
        kind: "invalidate",
        userVisibleOutput: true,
      }),
    ]);
    expect(listenerError).toHaveBeenCalledTimes(3);
    expect(service.revision("mission-1")).toBe(3);
  });

  it("returns the replaced live projection so its owner can close it", () => {
    const service = new MissionChatService<{ close: () => Promise<void> }>(() => undefined);
    const first = { close: async () => undefined };
    const second = { close: async () => undefined };

    expect(service.setLive("mission-1", first)).toBeUndefined();
    expect(service.setLive("mission-1", second)).toBe(first);
    expect(service.live("mission-1")).toBe(second);
  });

  it("coalesces Work projection loads and invalidates cached projections", async () => {
    const service = new MissionWorkService<{ entries: [] }>(() => undefined);
    const projection: MissionWorkProjection = {
      revision: 0,
      executionSignature: "execution-1:1",
      executionCount: 1,
      snapshot: { missionId: "mission-1", revision: 0, records: [] },
      entriesByRecordId: new Map(),
    };
    const loading = Promise.resolve(projection);
    service.beginLoad("mission-1", 0, projection.executionSignature, loading);
    expect(service.loading("mission-1", 0, projection.executionSignature)).toBe(loading);
    service.finishLoad("mission-1", loading);
    service.cache("mission-1", projection);
    expect(service.cached("mission-1", 0, projection.executionSignature)).toBe(projection);

    service.invalidate("mission-1", "user");
    expect(service.revision("mission-1")).toBe(1);
    expect(service.cached("mission-1", 1, projection.executionSignature)).toBeUndefined();
  });

  it("delivers command outcomes even when another subscriber throws", () => {
    const listenerError = vi.fn();
    const service = new MissionCommandService(listenerError);
    const received = vi.fn();
    service.subscribe(() => {
      throw new Error("listener failed");
    });
    service.subscribe(received);
    const notification = {
      missionId: "mission-1",
      requestId: "request-1",
      state: "applied" as const,
    };

    service.emit(notification);

    expect(received).toHaveBeenCalledWith(notification);
    expect(listenerError).toHaveBeenCalledOnce();
  });
});
