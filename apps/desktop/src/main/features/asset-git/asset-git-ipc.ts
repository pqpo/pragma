import { ipcMain } from "electron";

import {
  AssetGitBindSchema,
  AssetGitImportSchema,
  AssetGitTargetSchema,
} from "../../../shared/contracts/index.ts";
import type { AssetGitService } from "./asset-git-service.ts";

export function installAssetGitHandlers(service: AssetGitService): void {
  ipcMain.handle("asset-git:status", (_event, input: unknown) =>
    service.status(AssetGitTargetSchema.parse(input)),
  );
  ipcMain.handle("asset-git:bind", (_event, input: unknown) =>
    service.bind(AssetGitBindSchema.parse(input)),
  );
  ipcMain.handle("asset-git:unbind", (_event, input: unknown) =>
    service.unbind(AssetGitTargetSchema.parse(input)),
  );
  ipcMain.handle("asset-git:import", (_event, input: unknown) =>
    service.import(AssetGitImportSchema.parse(input)),
  );
  ipcMain.handle("asset-git:sync", (_event, input: unknown) =>
    service.sync(AssetGitTargetSchema.parse(input)),
  );
}
