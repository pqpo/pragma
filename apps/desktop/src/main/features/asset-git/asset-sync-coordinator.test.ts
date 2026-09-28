import { describe, expect, it, vi } from "vitest";

import type { AssetGitStatus, AssetGitTarget } from "../../../shared/contracts/index.ts";
import { createAssetSyncCoordinator } from "./asset-sync-coordinator.ts";

const targets: AssetGitTarget[] = [
  { kind: "knowledge", id: "00000000-0000-4000-8000-000000000001" },
  { kind: "knowledge", id: "00000000-0000-4000-8000-000000000002" },
  { kind: "skill", id: "00000000-0000-4000-8000-000000000003" },
];

const synced = (target: AssetGitTarget): AssetGitStatus => ({ target, status: "synced" });

describe("asset sync coordinator", () => {
  it("orders startup as core pull, bounded per-asset sync, then core backup", async () => {
    const events: string[] = [];
    let active = 0;
    let maximum = 0;
    const coordinator = createAssetSyncCoordinator({
      concurrency: 2,
      core: {
        refresh: async () => {
          events.push("core:pull");
          return {} as never;
        },
        sync: async () => {
          events.push("core:backup");
          return {} as never;
        },
      },
      assets: {
        listTargets: async () => targets,
        source: async () => ({}),
        sync: async (target) => {
          active += 1;
          maximum = Math.max(maximum, active);
          events.push(`asset:start:${target.id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`asset:end:${target.id}`);
          active -= 1;
          return synced(target);
        },
      },
    });

    await coordinator.start();

    expect(events[0]).toBe("core:pull");
    expect(events.at(-1)).toBe("core:backup");
    expect(maximum).toBe(2);
    coordinator.stop();
  });

  it("coalesces duplicate local publications before one core backup", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async (target: AssetGitTarget) => synced(target));
    const coreSync = vi.fn(async () => ({}) as never);
    const coordinator = createAssetSyncCoordinator({
      debounceMs: 10,
      core: { refresh: async () => ({}) as never, sync: coreSync },
      assets: { listTargets: async () => [], source: async () => ({}), sync },
    });

    coordinator.scheduleAsset(targets[0]!, "first");
    coordinator.scheduleAsset(targets[0]!, "second");
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(coreSync).toHaveBeenCalledOnce());

    expect(sync).toHaveBeenCalledOnce();
    coordinator.stop();
    vi.useRealTimers();
  });

  it("does not reschedule a publication produced by the active asset sync", async () => {
    vi.useFakeTimers();
    const coordinatorRef: { current?: ReturnType<typeof createAssetSyncCoordinator> } = {};
    const sync = vi.fn(async (target: AssetGitTarget) => {
      coordinatorRef.current?.scheduleAsset(target, "sync-published-local-revision");
      return synced(target);
    });
    const coreSync = vi.fn(async () => ({}) as never);
    const coordinator = createAssetSyncCoordinator({
      debounceMs: 10,
      core: { refresh: async () => ({}) as never, sync: coreSync },
      assets: { listTargets: async () => [], source: async () => ({}), sync },
    });
    coordinatorRef.current = coordinator;

    coordinator.scheduleAsset(targets[0]!, "local-publication");
    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() => expect(coreSync).toHaveBeenCalledOnce());

    expect(sync).toHaveBeenCalledOnce();
    coordinator.stop();
    vi.useRealTimers();
  });

  it("reports partial success when the overall backup fails and skips backup on conflicts", async () => {
    const backup = vi.fn(async () => {
      throw new Error("offline");
    });
    const sync = vi.fn(async (target: AssetGitTarget): Promise<AssetGitStatus> => synced(target));
    const coordinator = createAssetSyncCoordinator({
      core: { refresh: async () => ({}) as never, sync: backup },
      assets: { listTargets: async () => [], source: async () => ({}), sync },
    });
    expect(await coordinator.syncAsset(targets[0]!)).toMatchObject({
      status: "synced",
      backupFailed: true,
    });
    sync.mockImplementation(async (target) => ({
      target,
      status: "conflict",
      conflictPaths: ["SKILL.md"],
    }));
    expect((await coordinator.syncAsset(targets[0]!)).status).toBe("conflict");
    expect(backup).toHaveBeenCalledOnce();
    const resolve = vi.fn(async () => synced(targets[0]!));
    expect(await coordinator.syncAsset(targets[0]!, resolve)).toMatchObject({
      status: "synced",
      backupFailed: true,
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(backup).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("ignores new schedules after stop", async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async (target: AssetGitTarget) => synced(target));
    const coordinator = createAssetSyncCoordinator({
      core: { refresh: async () => ({}) as never, sync: async () => ({}) as never },
      assets: { listTargets: async () => [], source: async () => ({}), sync },
    });
    coordinator.stop();

    coordinator.scheduleAsset(targets[0]!, "late");
    await vi.runAllTimersAsync();

    expect(sync).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
