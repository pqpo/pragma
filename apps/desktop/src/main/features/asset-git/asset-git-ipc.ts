import { ipcMain } from "electron";

import {
  AssetGitBindSchema,
  ResolveAssetGitConflictsSchema,
  AssetGitImportSchema,
  AssetGitTargetSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { AssetGitService } from "./asset-git-service.ts";

export function installAssetGitHandlers(service: AssetGitService): void {
  ipcMain.handle("asset-git:status", (_event, input: unknown) =>
    service.status(AssetGitTargetSchema.parse(input)),
  );
  ipcMain.handle("asset-git:bind", (_event, input: unknown) =>
    runDesktopMutation(() => service.bind(AssetGitBindSchema.parse(input))),
  );
  ipcMain.handle("asset-git:unbind", (_event, input: unknown) =>
    runDesktopMutation(() => service.unbind(AssetGitTargetSchema.parse(input))),
  );
  ipcMain.handle("asset-git:import", (_event, input: unknown) =>
    runDesktopMutation(() => service.import(AssetGitImportSchema.parse(input))),
  );
  ipcMain.handle("asset-git:conflicts", (_event, input: unknown) =>
    service.conflicts(AssetGitTargetSchema.parse(input)),
  );
  ipcMain.handle("asset-git:resolve", (_event, input: unknown) =>
    runDesktopMutation(() => service.resolve(ResolveAssetGitConflictsSchema.parse(input))),
  );
  ipcMain.handle("asset-git:sync", (_event, input: unknown) =>
    runDesktopMutation(() => service.sync(AssetGitTargetSchema.parse(input))),
  );
}
