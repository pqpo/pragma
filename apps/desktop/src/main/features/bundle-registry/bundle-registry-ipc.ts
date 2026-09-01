import { ipcMain } from "electron";

import {
  AddDesktopBundleRegistrySourceSchema,
  DesktopBundleRegistrySourceRefSchema,
  DownloadDesktopSquareBundleSchema,
  GetDesktopSquareItemSchema,
  UpdateDesktopBundleRegistrySourceSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { DesktopBundleRegistrySourceService } from "./bundle-registry-source-service.ts";

export function installBundleRegistryHandlers(service: DesktopBundleRegistrySourceService): void {
  ipcMain.handle("bundle-registry:sources:list", () => service.listSources());
  ipcMain.handle("bundle-registry:sources:add", (_event, input: unknown) =>
    runDesktopMutation(() => service.addSource(AddDesktopBundleRegistrySourceSchema.parse(input))),
  );
  ipcMain.handle("bundle-registry:sources:update", (_event, input: unknown) =>
    runDesktopMutation(() =>
      service.updateSource(UpdateDesktopBundleRegistrySourceSchema.parse(input)),
    ),
  );
  ipcMain.handle("bundle-registry:sources:remove", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = DesktopBundleRegistrySourceRefSchema.parse(input);
      await service.removeSource(parsed.sourceId);
    }),
  );
  ipcMain.handle("bundle-registry:sources:refresh", (_event, input: unknown) =>
    runDesktopMutation(() => {
      const parsed = DesktopBundleRegistrySourceRefSchema.parse(input);
      return service.refreshSource(parsed.sourceId);
    }),
  );
  ipcMain.handle("bundle-registry:sources:refresh-all", () =>
    runDesktopMutation(() => service.refreshEnabledSources()),
  );
  ipcMain.handle("bundle-registry:catalog", () => service.getCatalog());
  ipcMain.handle("bundle-registry:item", (_event, input: unknown) =>
    service.getItem(GetDesktopSquareItemSchema.parse(input)),
  );
  ipcMain.handle("bundle-registry:download", (_event, input: unknown) =>
    runDesktopMutation(() =>
      service.downloadBundle(DownloadDesktopSquareBundleSchema.parse(input)),
    ),
  );
}
