import { describe, expect, it, vi } from "vitest";

import { MissionChatService } from "./mission-chat-service.ts";
import { MissionCommandService } from "./mission-command-service.ts";
import { MissionLifecycleService } from "./mission-lifecycle-service.ts";
import { MissionSessionService } from "./mission-session-service.ts";
import { MissionWorkService, type MissionWorkProjection } from "./mission-work-service.ts";

describe("Mission service state ownership", () => {
  it("coalesces lifecycle work and releases it after settlement", async () => {
    const service = new MissionLifecycleService<string, string, { readonly id: string }>();
    let resolveRun!: (value: string) => void;
    const first = service.startRun(
      "mission-1",
      () => new Promise<string>((resolve) => (resolveRun = resolve)),
    );
    const duplicate = service.startRun("mission-1", async () => "duplicate");

    expect(duplicate).toBe(first);
    resolveRun("done");
    await expect(first).resolves.toBe("done");
    await Promise.resolve();
    expect(service.run("mission-1")).toBeUndefined();

    const active = { id: "execution-1" };
    service.setActive("mission-1", active);
    expect(service.active("mission-1")).toBe(active);
    service.deleteActiveIfCurrent("mission-1", { id: "stale" });
    expect(service.hasActive("mission-1")).toBe(true);
    service.deleteActiveIfCurrent("mission-1", active);
    expect(service.hasActive("mission-1")).toBe(false);
  });

  it("keeps Session identity and invalidation state behind one registry", async () => {
    const service = new MissionSessionService<{ readonly id: string }>();
    const context = Promise.resolve({ id: "context-1" });
    service.setExecutionContext("mission-1", context);
    service.setCompilationIdentity("mission-1", "compile-1");
    service.setDefinitionFingerprint("mission-1", "definition-1");

    expect(await service.executionContext("mission-1")).toEqual({ id: "context-1" });
    service.invalidateContextBindings("mission-1");
    expect(service.executionContext("mission-1")).toBeUndefined();
    expect(service.compilationIdentity("mission-1")).toBeUndefined();
    expect(service.definitionFingerprint("mission-1")).toBeUndefined();
    expect(service.successorRequired("mission-1")).toBe(true);
    expect(service.consumeSuccessorRequirement("mission-1")).toBe(true);
    expect(service.consumeSuccessorRequirement("mission-1")).toBe(false);
  });

  it("increments chat revisions and contains listener failures", () => {
    const listenerError = vi.fn();
    const service = new MissionChatService<{ close: () => Promise<void> }>(listenerError);
    const updates: number[] = [];
    service.subscribe(() => {
      throw new Error("listener failed");
    });
    service.subscribe(({ update }) => updates.push(update.revision));

    service.emitPatches("mission-1", "user", [
      { type: "entry.append", entryId: "entry-1", field: "content", delta: "hello" },
    ]);
    service.invalidate("mission-1", "user");

    expect(updates).toEqual([1, 2]);
    expect(listenerError).toHaveBeenCalledTimes(2);
    expect(service.revision("mission-1")).toBe(2);
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
