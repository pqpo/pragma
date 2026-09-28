import type {
  AssetGitStatus,
  AssetGitTarget,
  CoreAssetSyncOverview,
} from "../../../shared/contracts/index.ts";

export interface AssetSyncCoordinator {
  scheduleCore(reason: string): void;
  scheduleAsset(target: AssetGitTarget, reason: string): void;
  start(): Promise<void>;
  stop(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  syncAsset(
    target: AssetGitTarget,
    synchronize?: () => Promise<AssetGitStatus>,
  ): Promise<AssetGitStatus>;
}

export function createAssetSyncCoordinator(options: {
  readonly core: {
    refresh(): Promise<CoreAssetSyncOverview>;
    sync(): Promise<CoreAssetSyncOverview>;
  };
  readonly assets: {
    listTargets(): Promise<readonly AssetGitTarget[]>;
    source(target: AssetGitTarget): Promise<unknown | undefined>;
    sync(target: AssetGitTarget): Promise<AssetGitStatus>;
  };
  readonly concurrency?: number | undefined;
  readonly debounceMs?: number | undefined;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): AssetSyncCoordinator {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const debounceMs = Math.max(0, options.debounceMs ?? 1_000);
  const pendingTargets = new Map<string, AssetGitTarget>();
  const activeTargets = new Set<string>();
  let pendingCore = false;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;
  let started = false;
  let running = false;

  const keyOf = (target: AssetGitTarget) => `${target.kind}:${target.id}`;
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new Error("Asset sync coordinator is stopped."));
    const result = tail.then(async () => {
      if (stopped) throw new Error("Asset sync coordinator is stopped.");
      running = true;
      try {
        return await operation();
      } finally {
        running = false;
        requestFlush();
      }
    });
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const syncTargets = async (targets: readonly AssetGitTarget[]): Promise<void> => {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (!stopped) {
        const index = next;
        next += 1;
        const target = targets[index];
        if (target === undefined) return;
        const key = keyOf(target);
        try {
          if ((await options.assets.source(target)) === undefined) continue;
          activeTargets.add(key);
          const status = await options.assets.sync(target);
          if (status.status === "pending") pendingTargets.set(key, target);
          if (status.status === "error" || status.status === "conflict") {
            options.warn?.(
              `Automatic Git sync requires attention for ${key} (${status.status}).`,
              new Error(status.error ?? status.conflictPaths?.join(", ") ?? status.status),
            );
          }
        } catch (error) {
          options.warn?.(`Automatic Git sync failed for ${key}.`, error);
        } finally {
          activeTargets.delete(key);
        }
      }
    });
    await Promise.all(workers);
  };

  const flush = async (): Promise<void> => {
    if (stopped || (pendingTargets.size === 0 && !pendingCore)) return;
    const targets = [...pendingTargets.values()];
    const syncCore = pendingCore || targets.length > 0;
    pendingTargets.clear();
    pendingCore = false;
    await queue(async () => {
      await syncTargets(targets);
      if (syncCore && !stopped) {
        pendingCore = false;
        await options.core.sync();
      }
    }).catch((error: unknown) => options.warn?.("Asset synchronization failed.", error));
  };

  function requestFlush(): void {
    if (stopped || running || scheduled !== undefined) return;
    if (pendingTargets.size === 0 && !pendingCore) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void flush();
    }, debounceMs);
  }

  return {
    scheduleCore() {
      if (stopped) return;
      pendingCore = true;
      requestFlush();
    },
    scheduleAsset(target) {
      if (stopped) return;
      const key = keyOf(target);
      if (activeTargets.has(key)) pendingCore = true;
      else pendingTargets.set(key, target);
      requestFlush();
    },
    async start() {
      if (stopped || started) return;
      started = true;
      await queue(async () => {
        await options.core.refresh();
        const targets = await options.assets.listTargets();
        for (const target of targets) pendingTargets.delete(keyOf(target));
        await syncTargets(targets);
        if (!stopped) {
          pendingCore = false;
          await options.core.sync();
        }
      });
    },
    stop() {
      stopped = true;
      if (scheduled !== undefined) clearTimeout(scheduled);
      scheduled = undefined;
      pendingTargets.clear();
      pendingCore = false;
    },
    run: queue,
    async syncAsset(target, synchronize = () => options.assets.sync(target)) {
      return await queue(async () => {
        const key = keyOf(target);
        activeTargets.add(key);
        let status: AssetGitStatus;
        try {
          status = await synchronize();
        } finally {
          activeTargets.delete(key);
        }
        if (status.status === "pending") pendingTargets.set(key, target);
        if (!stopped && status.status === "synced") {
          pendingCore = false;
          try {
            const backup = await options.core.sync();
            if (backup.status === "error" || backup.status === "conflict")
              return { ...status, backupFailed: true };
          } catch (error) {
            options.warn?.("Asset synchronized, but core backup failed.", error);
            return { ...status, backupFailed: true };
          }
        }
        return status;
      });
    },
  };
}
