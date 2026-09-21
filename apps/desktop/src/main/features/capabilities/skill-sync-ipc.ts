import { ipcMain } from "electron";

import {
  ResolveSkillSyncConflictSchema,
  RestoreIgnoredRemoteSkillSchema,
  UpdateSkillSyncConfigurationSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { SkillSyncService } from "./skill-sync-service.ts";

export function installSkillSyncHandlers(service: SkillSyncService): void {
  ipcMain.handle("skill-sync:get", () => service.getOverview());
  ipcMain.handle("skill-sync:configure", (_event, input: unknown) =>
    runDesktopMutation(() => service.configure(UpdateSkillSyncConfigurationSchema.parse(input))),
  );
  ipcMain.handle("skill-sync:remove", () =>
    runDesktopMutation(async () => await service.removeConfiguration()),
  );
  ipcMain.handle("skill-sync:run", () => runDesktopMutation(() => service.sync()));
  ipcMain.handle("skill-sync:refresh", () => runDesktopMutation(() => service.refresh()));
  ipcMain.handle("skill-sync:resolve", (_event, input: unknown) =>
    runDesktopMutation(() => {
      const parsed = ResolveSkillSyncConflictSchema.parse(input);
      return service.resolveConflict(parsed.syncKey, parsed.choice);
    }),
  );
  ipcMain.handle("skill-sync:restore", (_event, input: unknown) =>
    runDesktopMutation(() => {
      const parsed = RestoreIgnoredRemoteSkillSchema.parse(input);
      return service.restoreIgnored(parsed.syncKey);
    }),
  );
}
