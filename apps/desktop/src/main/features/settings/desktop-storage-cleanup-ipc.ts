import { ipcMain } from "electron";
import {
  clearRebuildableCache,
  emptyCompletedTrash,
  inspectStorageCleanup,
  type PragmaPaths,
} from "@pragma/core";

import {
  DeleteCompletedTaskMissionSchema,
  DesktopStorageCleanupOverviewSchema,
  DesktopStorageCleanupResultSchema,
} from "../../../shared/contracts/storage-cleanup.ts";
import type { MissionStore } from "@pragma/local-host";
import type { LocalHostMissionApplication } from "@pragma/local-host";

export function installDesktopStorageCleanupHandlers(options: {
  readonly paths: PragmaPaths;
  readonly missions: Pick<MissionStore, "claimCompletedTaskDeletion">;
  readonly application: Pick<LocalHostMissionApplication, "delete">;
}): void {
  ipcMain.handle("storage:inspect-cleanup", async () =>
    DesktopStorageCleanupOverviewSchema.parse(await inspectStorageCleanup(options.paths)),
  );
  ipcMain.handle("storage:clear-cache", async () =>
    DesktopStorageCleanupResultSchema.parse(await clearRebuildableCache(options.paths)),
  );
  ipcMain.handle("storage:empty-trash", async () =>
    DesktopStorageCleanupResultSchema.parse(await emptyCompletedTrash(options.paths)),
  );
  ipcMain.handle("storage:delete-completed-task-mission", async (_event, input: unknown) => {
    const { id } = DeleteCompletedTaskMissionSchema.parse(input);
    await deleteCompletedTaskMission(options, id);
  });
}

export async function deleteCompletedTaskMission(
  options: {
    readonly missions: Pick<MissionStore, "claimCompletedTaskDeletion">;
    readonly application: Pick<LocalHostMissionApplication, "delete">;
  },
  id: string,
): Promise<void> {
  await options.missions.claimCompletedTaskDeletion(id);
  await options.application.delete(id);
}
