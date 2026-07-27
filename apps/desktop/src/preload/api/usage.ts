import { ipcRenderer, type IpcRendererEvent } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  MissionUsageRequestSchema,
  MissionUsageSchema,
  UsageOverviewRequestSchema,
  UsageOverviewSchema,
  UsageSubjectListRequestSchema,
  UsageSubjectListSchema,
  UsageUpdateSchema,
} from "../../shared/contracts/usage.ts";

export const usageApi = {
  getUsageOverview: async (input) =>
    UsageOverviewSchema.parse(
      await ipcRenderer.invoke("usage:overview:get", UsageOverviewRequestSchema.parse(input)),
    ),
  listUsageSubjects: async (input) =>
    UsageSubjectListSchema.parse(
      await ipcRenderer.invoke("usage:subjects:list", UsageSubjectListRequestSchema.parse(input)),
    ),
  getMissionUsage: async (missionId) =>
    MissionUsageSchema.parse(
      await ipcRenderer.invoke("usage:mission:get", MissionUsageRequestSchema.parse({ missionId })),
    ),
  subscribeUsageUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      listener(UsageUpdateSchema.parse(value));
    };
    ipcRenderer.on("usage:updated", handler);
    return () => ipcRenderer.removeListener("usage:updated", handler);
  },
} satisfies Pick<
  PragmaDesktopAPI,
  "getUsageOverview" | "listUsageSubjects" | "getMissionUsage" | "subscribeUsageUpdates"
>;
