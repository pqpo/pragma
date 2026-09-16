import { ipcMain } from "electron";

import {
  ResolveKnowledgeSyncConflictSchema,
  RestoreIgnoredRemoteKnowledgeBaseSchema,
  UpdateKnowledgeSyncConfigurationSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { KnowledgeSyncService } from "./knowledge-sync-service.ts";

export function installKnowledgeSyncHandlers(service: KnowledgeSyncService): void {
  ipcMain.handle("knowledge-sync:get", () => service.getOverview());
  ipcMain.handle("knowledge-sync:configure", (_event, input: unknown) =>
    runDesktopMutation(() =>
      service.configure(UpdateKnowledgeSyncConfigurationSchema.parse(input)),
    ),
  );
  ipcMain.handle("knowledge-sync:remove", () =>
    runDesktopMutation(async () => await service.removeConfiguration()),
  );
  ipcMain.handle("knowledge-sync:run", () => runDesktopMutation(() => service.sync()));
  ipcMain.handle("knowledge-sync:refresh", () => runDesktopMutation(() => service.refresh()));
  ipcMain.handle("knowledge-sync:resolve", (_event, input: unknown) =>
    runDesktopMutation(() => {
      const parsed = ResolveKnowledgeSyncConflictSchema.parse(input);
      return service.resolveConflict(parsed.storeId, parsed.choice);
    }),
  );
  ipcMain.handle("knowledge-sync:restore", (_event, input: unknown) =>
    runDesktopMutation(() => {
      const parsed = RestoreIgnoredRemoteKnowledgeBaseSchema.parse(input);
      return service.restoreIgnored(parsed.storeId);
    }),
  );
}
