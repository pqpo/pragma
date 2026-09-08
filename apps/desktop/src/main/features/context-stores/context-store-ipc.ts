import { constants as fsConstants, watch, type FSWatcher } from "node:fs";
import { access, stat } from "node:fs/promises";
import { basename } from "node:path";

import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { z } from "zod";

import {
  CreateContextStoreFileSchema,
  CreateContextStoreFolderSchema,
  CreateContextStoreSchema,
  DeleteContextStoreEntrySchema,
  DeleteContextStoreSchema,
  GetContextStoreContentSchema,
  InspectContextStoreImportSchema,
  ListContextStoreEntriesSchema,
  RenameContextStoreEntrySchema,
  SubscribeContextStoreChangesSchema,
  UpdateContextStoreFileSchema,
  ContextStoreRevisionJobRefSchema,
  ContextStoreDraftRefSchema,
  CreateContextStoreDraftSchema,
  GetContextStoreDraftFileSchema,
  ContextStoreRevisionRequestSchema,
  ListContextStoreRevisionJobsSchema,
  ListContextStoreDraftsSchema,
  RebaseContextStoreDraftSchema,
  SubmitContextStoreDraftSchema,
  UpdateContextStoreRevisionProfileSchema,
  UpdateContextStoreDraftFileSchema,
  type PickWorkspaceResult,
} from "../../../shared/contracts/index.ts";
import type { ContextStoreStore } from "./context-store-store.ts";
import type { ContextStoreRevisionService } from "./context-store-revision-service.ts";

interface ContextStoreWatchSubscription {
  readonly sender: WebContents;
  readonly onDestroyed: () => void;
  watcher?: FSWatcher | undefined;
  notificationTimer?: NodeJS.Timeout | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function installContextStoreHandlers(
  store: ContextStoreStore,
  windowGetter: () => BrowserWindow | null,
  revisions?: ContextStoreRevisionService,
): void {
  const watchers = new Map<string, ContextStoreWatchSubscription>();
  const watcherKey = (webContentsId: number, storeId: string) => `${webContentsId}:${storeId}`;
  const closeWatcher = (key: string, expected?: ContextStoreWatchSubscription): void => {
    const subscription = watchers.get(key);
    if (subscription === undefined || (expected !== undefined && subscription !== expected)) return;
    watchers.delete(key);
    if (subscription.notificationTimer !== undefined) {
      clearTimeout(subscription.notificationTimer);
    }
    subscription.watcher?.close();
    subscription.sender.removeListener("destroyed", subscription.onDestroyed);
  };
  ipcMain.handle("context-stores:list", () => store.list());
  ipcMain.handle("context-stores:create", (_event, input: unknown) =>
    store.create(CreateContextStoreSchema.parse(input)),
  );
  ipcMain.handle("context-stores:inspect-import", (_event, input: unknown) => {
    const parsed = InspectContextStoreImportSchema.parse(input);
    return store.inspectImport(parsed.sourcePath);
  });
  ipcMain.handle("context-stores:delete", async (_event, input: unknown) => {
    await store.remove(DeleteContextStoreSchema.parse(input).storeId);
  });
  ipcMain.handle("context-stores:get-content", (_event, input: unknown) => {
    const parsed = GetContextStoreContentSchema.parse(input);
    return store.getContent(parsed.storeId, parsed.contentId);
  });
  ipcMain.handle("context-stores:list-entries", (_event, input: unknown) => {
    const parsed = ListContextStoreEntriesSchema.parse(input);
    return store.listEntries(parsed.storeId);
  });
  ipcMain.handle("context-stores:create-folder", async (_event, input: unknown) => {
    const parsed = CreateContextStoreFolderSchema.parse(input);
    await store.createFolder(parsed.storeId, parsed.id);
  });
  ipcMain.handle("context-stores:create-file", (_event, input: unknown) => {
    const parsed = CreateContextStoreFileSchema.parse(input);
    return store.createFile(parsed.storeId, parsed.id, parsed.content, parsed.metadata);
  });
  ipcMain.handle("context-stores:update-file", (_event, input: unknown) => {
    const parsed = UpdateContextStoreFileSchema.parse(input);
    return store.updateFile(
      parsed.storeId,
      parsed.id,
      parsed.content,
      parsed.metadata,
      parsed.expectedRevision,
    );
  });
  ipcMain.handle("context-stores:rename-entry", async (_event, input: unknown) => {
    const parsed = RenameContextStoreEntrySchema.parse(input);
    await store.renameEntry(parsed.storeId, parsed.id, parsed.nextId, parsed.kind);
  });
  ipcMain.handle("context-stores:delete-entry", async (_event, input: unknown) => {
    const parsed = DeleteContextStoreEntrySchema.parse(input);
    await store.deleteEntry(parsed.storeId, parsed.id, parsed.kind);
  });
  if (revisions !== undefined) {
    ipcMain.handle("context-store-revisions:submit", async (_event, input: unknown) => {
      const job = await revisions.submit(ContextStoreRevisionRequestSchema.parse(input));
      revisions.scheduleProcessing();
      return job;
    });
    ipcMain.handle("context-store-revisions:list", (_event, input: unknown) =>
      revisions.list(ListContextStoreRevisionJobsSchema.parse(input ?? {})),
    );
    ipcMain.handle("context-store-revisions:get", (_event, jobId: unknown) =>
      revisions.get(z.string().uuid().parse(jobId)),
    );
    ipcMain.handle("context-store-revisions:approve", async (_event, input: unknown) => {
      const parsed = ContextStoreRevisionJobRefSchema.parse(input);
      const result = await revisions.approve(parsed.jobId, parsed.expectedRevision);
      revisions.scheduleProcessing();
      return result;
    });
    ipcMain.handle("context-store-revisions:reject", async (_event, input: unknown) => {
      const parsed = ContextStoreRevisionJobRefSchema.parse(input);
      const result = await revisions.reject(parsed.jobId, parsed.expectedRevision);
      revisions.scheduleProcessing();
      return result;
    });
    ipcMain.handle("context-store-revisions:retry", async (_event, input: unknown) => {
      const parsed = ContextStoreRevisionJobRefSchema.parse(input);
      const result = await revisions.retry(parsed.jobId, parsed.expectedRevision);
      revisions.scheduleProcessing();
      return result;
    });
    ipcMain.handle("context-store-revisions:delete", async (_event, input: unknown) => {
      const parsed = ContextStoreRevisionJobRefSchema.parse(input);
      await revisions.delete(parsed.jobId, parsed.expectedRevision);
    });
    ipcMain.handle("context-store-drafts:create", (_event, input: unknown) =>
      revisions.createDraft(CreateContextStoreDraftSchema.parse(input)),
    );
    ipcMain.handle("context-store-drafts:list", (_event, input: unknown) =>
      revisions.listDrafts(ListContextStoreDraftsSchema.parse(input ?? {})),
    );
    ipcMain.handle("context-store-drafts:get", (_event, draftId: unknown) =>
      revisions.getDraft(z.string().uuid().parse(draftId)),
    );
    ipcMain.handle("context-store-drafts:get-change-set", (_event, draftId: unknown) =>
      revisions.getDraftChangeSet(z.string().uuid().parse(draftId)),
    );
    ipcMain.handle("context-store-drafts:get-file", (_event, input: unknown) =>
      revisions.getDraftFile(GetContextStoreDraftFileSchema.parse(input)),
    );
    ipcMain.handle("context-store-drafts:submit", (_event, input: unknown) => {
      const parsed = SubmitContextStoreDraftSchema.parse(input);
      return revisions.submitDraft(parsed.draftId, parsed.expectedRevision, parsed.summary);
    });
    ipcMain.handle("context-store-drafts:update-file", (_event, input: unknown) =>
      revisions.updateDraftFile(UpdateContextStoreDraftFileSchema.parse(input)),
    );
    ipcMain.handle("context-store-drafts:discard", async (_event, input: unknown) => {
      const parsed = ContextStoreDraftRefSchema.parse(input);
      await revisions.discardDraft(parsed.draftId, parsed.expectedRevision);
    });
    ipcMain.handle("context-store-drafts:inspect-rebase", (_event, draftId: unknown) =>
      revisions.inspectRebase(z.string().uuid().parse(draftId)),
    );
    ipcMain.handle("context-store-drafts:rebase", (_event, input: unknown) =>
      revisions.rebase(RebaseContextStoreDraftSchema.parse(input)),
    );
    ipcMain.handle("context-store-revisions:get-profile", () => revisions.getProfile());
    ipcMain.handle("context-store-revisions:update-profile", async (_event, input: unknown) => {
      const profile = await revisions.updateProfile(
        UpdateContextStoreRevisionProfileSchema.parse(input),
      );
      revisions.scheduleProcessing();
      return profile;
    });
  }
  ipcMain.on("context-stores:watch", (event, input: unknown) => {
    const parsed = SubscribeContextStoreChangesSchema.parse(input);
    const key = watcherKey(event.sender.id, parsed.storeId);
    closeWatcher(key);
    const sendChange = () => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send("context-stores:changed", { storeId: parsed.storeId });
        }
      } catch {
        // WebContents can be destroyed between the state check and send.
      }
    };
    const subscription: ContextStoreWatchSubscription = {
      sender: event.sender,
      onDestroyed: () => closeWatcher(key, subscription),
    };
    const notify = () => {
      if (subscription.notificationTimer !== undefined) {
        clearTimeout(subscription.notificationTimer);
      }
      subscription.notificationTimer = setTimeout(() => {
        subscription.notificationTimer = undefined;
        sendChange();
      }, 100);
    };
    watchers.set(key, subscription);
    event.sender.once("destroyed", subscription.onDestroyed);
    void (async () => {
      try {
        const path = await store.filesPath(parsed.storeId);
        if (watchers.get(key) !== subscription || event.sender.isDestroyed()) {
          closeWatcher(key, subscription);
          return;
        }
        const watcher = watch(path, { recursive: true }, notify);
        if (watchers.get(key) !== subscription || event.sender.isDestroyed()) {
          watcher.close();
          closeWatcher(key, subscription);
          return;
        }
        subscription.watcher = watcher;
        watcher.on("error", () => {
          sendChange();
          closeWatcher(key, subscription);
        });
      } catch {
        if (watchers.get(key) === subscription) {
          sendChange();
          closeWatcher(key, subscription);
        }
      }
    })();
  });
  ipcMain.on("context-stores:unwatch", (event, input: unknown) => {
    const parsed = SubscribeContextStoreChangesSchema.parse(input);
    const key = watcherKey(event.sender.id, parsed.storeId);
    closeWatcher(key);
  });
  ipcMain.handle("context-stores:pick-folder", async (): Promise<PickWorkspaceResult> => {
    const window = windowGetter();
    if (!window) return { ok: false, reason: "no_window" };

    try {
      const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
      const path = result.filePaths[0];
      if (result.canceled || !path) return { ok: false, reason: "cancelled" };
      if (!(await stat(path)).isDirectory()) return { ok: false, reason: "not_directory" };
      await access(path, fsConstants.R_OK);
      return { ok: true, path, basename: basename(path) };
    } catch (error) {
      return { ok: false, reason: "not_accessible", error: errorMessage(error) };
    }
  });
}
