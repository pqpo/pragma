import { ipcMain } from "electron";

import {
  ResolveCoreAssetSyncConflictSchema,
  UpdateCoreAssetSyncConfigurationSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { CoreAssetSyncService } from "./core-asset-sync-service.ts";

export function installCoreAssetSyncHandlers(service: CoreAssetSyncService): void {
  ipcMain.handle("core-asset-sync:get", () => service.overview());
  ipcMain.handle("core-asset-sync:configure", (_event, input: unknown) =>
    runDesktopMutation(() =>
      service.configure(UpdateCoreAssetSyncConfigurationSchema.parse(input)),
    ),
  );
  ipcMain.handle("core-asset-sync:remove", () =>
    runDesktopMutation(() => service.removeConfiguration()),
  );
  ipcMain.handle("core-asset-sync:run", () => runDesktopMutation(() => service.sync()));
  ipcMain.handle("core-asset-sync:refresh", () => runDesktopMutation(() => service.refresh()));
  ipcMain.handle("core-asset-sync:resolve", (_event, input: unknown) =>
    runDesktopMutation(() => {
      const parsed = ResolveCoreAssetSyncConflictSchema.parse(input);
      return service.resolve(parsed.key, parsed.choice);
    }),
  );
  ipcMain.handle("core-asset-sync:restore", (_event, input: unknown) =>
    runDesktopMutation(() => service.restore(zKey(input))),
  );
}

function zKey(input: unknown): string {
  return ResolveCoreAssetSyncConflictSchema.shape.key.parse(input);
}
