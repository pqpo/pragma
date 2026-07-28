import { ipcMain, type BrowserWindow } from "electron";

import {
  MissionUsageRequestSchema,
  UsageOverviewRequestSchema,
  UsageSubjectListRequestSchema,
} from "../../../shared/contracts/index.ts";
import type { DesktopUsageStore } from "./usage-store.ts";

export function installUsageHandlers(
  store: DesktopUsageStore,
  getWindow: () => BrowserWindow | null,
): () => void {
  ipcMain.handle("usage:overview:get", (_event, input: unknown) => {
    const request = UsageOverviewRequestSchema.parse(input);
    return store.getOverview(request.period);
  });
  ipcMain.handle("usage:subjects:list", (_event, input: unknown) => {
    const request = UsageSubjectListRequestSchema.parse(input);
    return store.listSubjects(request);
  });
  ipcMain.handle("usage:mission:get", (_event, input: unknown) => {
    const request = MissionUsageRequestSchema.parse(input);
    return store.getMissionUsage(request.missionId);
  });
  return store.subscribe((update) => {
    getWindow()?.webContents.send("usage:updated", update);
  });
}
