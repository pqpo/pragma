import { ipcMain } from "electron";
import { UpdateRuntimeProcessEnvironmentPolicySchema } from "@pragma/shared";
import type { RuntimeProcessEnvironmentSettingsStore } from "@pragma/local-host";

import { GetDesktopRuntimeAvailabilityOptionsSchema } from "../../../shared/contracts/index.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
import type {
  DesktopRuntimeProcessEnvironment,
  ShellEnvironmentSnapshot,
} from "./desktop-runtime-process-environment.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";

export function installRuntimeHandlers(
  service: RuntimeEnvironmentService,
  processEnvironment: DesktopRuntimeProcessEnvironment,
  settings: RuntimeProcessEnvironmentSettingsStore,
): void {
  ipcMain.handle("runtimes:availability", (_event, options) => {
    const parsedOptions =
      options === undefined ? undefined : GetDesktopRuntimeAvailabilityOptionsSchema.parse(options);
    return getRuntimeAvailability(service, parsedOptions);
  });
  ipcMain.handle("runtimes:process-environment:status", async () =>
    runtimeProcessEnvironmentStatus(await processEnvironment.getSnapshot()),
  );
  ipcMain.handle("runtimes:process-environment:refresh", async () =>
    runtimeProcessEnvironmentStatus(await processEnvironment.refresh()),
  );
  ipcMain.handle("runtimes:process-environment:settings:get", async () => await settings.get());
  ipcMain.handle("runtimes:process-environment:settings:update", async (_event, input: unknown) => {
    const parsed = UpdateRuntimeProcessEnvironmentPolicySchema.parse(input);
    return await settings.updatePolicy(parsed);
  });
}

function runtimeProcessEnvironmentStatus(snapshot: ShellEnvironmentSnapshot) {
  return {
    generation: snapshot.generation,
    status: snapshot.failureKind === undefined ? ("ready" as const) : ("degraded" as const),
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    ...(snapshot.failureKind === undefined ? {} : { failureKind: snapshot.failureKind }),
  };
}
