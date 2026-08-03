import {
  runTrashMaintenance,
  type PragmaLogger,
  type PragmaPaths,
  type TrashMaintenanceResult,
} from "@pragma/core";

export interface DesktopTrashMaintenance {
  schedule(reason: string): void;
}

export function createDesktopTrashMaintenance(options: {
  readonly paths: PragmaPaths;
  readonly logger: Pick<PragmaLogger, "info" | "warn">;
  readonly maintain?: (() => Promise<TrashMaintenanceResult>) | undefined;
}): DesktopTrashMaintenance {
  const maintain =
    options.maintain ?? (async () => await runTrashMaintenance({ paths: options.paths }));
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

  return {
    schedule(reason) {
      pendingReason = reason;
      void drain();
    },
  };
}
