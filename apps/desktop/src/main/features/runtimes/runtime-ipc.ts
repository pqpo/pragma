import { ipcMain } from "electron";

import { GetDesktopRuntimeAvailabilityOptionsSchema } from "../../../shared/contracts/index.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";

export function installRuntimeHandlers(service: RuntimeEnvironmentService): void {
  ipcMain.handle("runtimes:availability", (_event, options) => {
    const parsedOptions =
      options === undefined ? undefined : GetDesktopRuntimeAvailabilityOptionsSchema.parse(options);
    return getRuntimeAvailability(service, parsedOptions);
  });
}
