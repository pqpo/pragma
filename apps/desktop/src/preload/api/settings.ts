import { ipcRenderer } from "electron";

import {
  DesktopSettingsSnapshotSchema,
  UpdateDesktopSettingsSchema,
} from "../../shared/contracts/settings.ts";
import {
  DeleteCompletedTaskMissionSchema,
  DesktopStorageCleanupOverviewSchema,
  DesktopStorageCleanupResultSchema,
} from "../../shared/contracts/storage-cleanup.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const settingsApi = {
  getDesktopSettings: async () =>
    DesktopSettingsSnapshotSchema.parse(await ipcRenderer.invoke("desktop-settings:get")),
  updateDesktopSettings: async (input) =>
    DesktopSettingsSnapshotSchema.parse(
      await ipcRenderer.invoke("desktop-settings:update", UpdateDesktopSettingsSchema.parse(input)),
    ),
  inspectStorageCleanup: async () =>
    DesktopStorageCleanupOverviewSchema.parse(await ipcRenderer.invoke("storage:inspect-cleanup")),
  clearRebuildableCache: async () =>
    DesktopStorageCleanupResultSchema.parse(await ipcRenderer.invoke("storage:clear-cache")),
  emptyCompletedTrash: async () =>
    DesktopStorageCleanupResultSchema.parse(await ipcRenderer.invoke("storage:empty-trash")),
  deleteCompletedTaskMission: async (id) => {
    await ipcRenderer.invoke(
      "storage:delete-completed-task-mission",
      DeleteCompletedTaskMissionSchema.parse({ id }),
    );
  },
} satisfies Pick<
  PragmaDesktopAPI,
  | "getDesktopSettings"
  | "updateDesktopSettings"
  | "inspectStorageCleanup"
  | "clearRebuildableCache"
  | "emptyCompletedTrash"
  | "deleteCompletedTaskMission"
>;
