import {
  runTransientStorageMaintenance,
  type PragmaLogger,
  type PragmaPaths,
  type TransientStorageMaintenanceResult,
} from "@pragma/core";

export interface DesktopTrashMaintenance {
  schedule(reason: string): void;
}

export function createDesktopTrashMaintenance(options: {
  readonly paths: PragmaPaths;
  readonly logger: Pick<PragmaLogger, "info" | "warn">;
  readonly maintain?: (() => Promise<TransientStorageMaintenanceResult>) | undefined;
}): DesktopTrashMaintenance {
  const DAILY_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
  const maintain =
    options.maintain ??
    (async () => await runTransientStorageMaintenance({ paths: options.paths }));
  let pendingReason: string | undefined;
  let running = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (pendingReason !== undefined) {
        const reason = pendingReason;
        pendingReason = undefined;
        try {
          const result = await maintain();
          options.logger.info(
            "desktop.trash_maintenance_completed",
            "Desktop Trash retention maintenance completed.",
            {
              reason,
              deletedEntries: result.deletedEntries,
              reclaimedBytes: result.reclaimedBytes,
              trashBytes: result.afterBytes,
              deletedCacheEntries: result.deletedCacheEntries,
              deletedTemporaryEntries: result.deletedTemporaryEntries,
              deletedMigrationBackups: result.deletedMigrationBackups,
            },
          );
        } catch (error) {
          options.logger.warn(
            "desktop.trash_maintenance_failed",
            "Desktop Trash retention maintenance failed and will be retried later.",
            { reason, error },
          );
        }
      }
    } finally {
      running = false;
      if (pendingReason !== undefined) void drain();
    }
  };

  const maintenance: DesktopTrashMaintenance = {
    schedule(reason) {
      pendingReason = reason;
      void drain();
    },
  };
  const interval = setInterval(() => maintenance.schedule("daily"), DAILY_MAINTENANCE_INTERVAL_MS);
  interval.unref();
  return maintenance;
}
