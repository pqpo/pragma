import { ipcMain } from "electron";

import { getRuntimeAvailability } from "./runtime-availability.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";

export function installRuntimeHandlers(service: RuntimeEnvironmentService): void {
  ipcMain.handle("runtimes:availability", () => getRuntimeAvailability(service));
}
