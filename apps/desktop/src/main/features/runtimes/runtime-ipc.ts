import { ipcMain } from "electron";

import { SetDefaultRuntimeSchema } from "../../../shared/contracts/index.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";
import type { RuntimeEnvironmentStore } from "./runtime-environment-store.ts";

export function installRuntimeHandlers(
  store: RuntimeEnvironmentStore,
  service: RuntimeEnvironmentService,
): void {
  ipcMain.handle("runtimes:availability", () => getRuntimeAvailability(service));
  ipcMain.handle("runtimes:set-default", async (_event, input: unknown) => {
    const { runtimeId } = SetDefaultRuntimeSchema.parse(input);
    await store.setDefaultRuntimeId(runtimeId);
    return await getRuntimeAvailability(service);
  });
}
