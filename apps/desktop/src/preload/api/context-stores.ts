import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  ContextStoreChangeSetSchema,
  ContextStoreContentSchema,
  ContextStoreEntrySchema,
  ContextStoreImportInspectionSchema,
  ContextStoreSchema,
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
} from "../../shared/contracts/context-stores.ts";
import {
  ContextStoreRevisionJobRefSchema,
  ContextStoreDraftRebaseInspectionSchema,
  ContextStoreDraftRefSchema,
  ContextStoreDraftSchema,
  CreateContextStoreDraftSchema,
  GetContextStoreDraftFileSchema,
  ContextStoreRevisionJobSchema,
  ContextStoreRevisionProfileSchema,
  ContextStoreRevisionRequestSchema,
  ListContextStoreRevisionJobsSchema,
  ListContextStoreDraftsSchema,
  RebaseContextStoreDraftSchema,
  SubmitContextStoreDraftSchema,
  UpdateContextStoreRevisionProfileSchema,
  UpdateContextStoreDraftFileSchema,
} from "../../shared/contracts/context-store-revisions.ts";
import { PickWorkspaceResultSchema } from "../../shared/contracts/settings.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const contextStoresApi = {
  listContextStores: async () =>
    ContextStoreSchema.array().parse(await ipcRenderer.invoke("context-stores:list")),
  createContextStore: async (input) =>
    ContextStoreSchema.parse(
      await ipcRenderer.invoke("context-stores:create", CreateContextStoreSchema.parse(input)),
    ),
  inspectContextStoreImport: async (input) =>
    ContextStoreImportInspectionSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:inspect-import",
        InspectContextStoreImportSchema.parse(input),
      ),
    ),
  deleteContextStore: async (input) => {
    await ipcRenderer.invoke("context-stores:delete", DeleteContextStoreSchema.parse(input));
  },
  getContextStoreContent: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:get-content",
        GetContextStoreContentSchema.parse(input),
      ),
    ),
  listContextStoreEntries: async (input) =>
    ContextStoreEntrySchema.array().parse(
      await ipcRenderer.invoke(
        "context-stores:list-entries",
        ListContextStoreEntriesSchema.parse(input),
      ),
    ),
  createContextStoreFolder: async (input) => {
    await ipcRenderer.invoke(
      "context-stores:create-folder",
      CreateContextStoreFolderSchema.parse(input),
    );
  },
  createContextStoreFile: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:create-file",
        CreateContextStoreFileSchema.parse(input),
      ),
    ),
  updateContextStoreFile: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-stores:update-file",
        UpdateContextStoreFileSchema.parse(input),
      ),
    ),
  renameContextStoreEntry: async (input) => {
    await ipcRenderer.invoke(
      "context-stores:rename-entry",
      RenameContextStoreEntrySchema.parse(input),
    );
  },
  deleteContextStoreEntry: async (input) => {
    await ipcRenderer.invoke(
      "context-stores:delete-entry",
      DeleteContextStoreEntrySchema.parse(input),
    );
  },
  submitContextStoreRevision: async (input) =>
    ContextStoreRevisionJobSchema.parse(
      await ipcRenderer.invoke(
        "context-store-revisions:submit",
        ContextStoreRevisionRequestSchema.parse(input),
      ),
    ),
  listContextStoreRevisions: async (input = {}) =>
    ContextStoreRevisionJobSchema.array().parse(
      await ipcRenderer.invoke(
        "context-store-revisions:list",
        ListContextStoreRevisionJobsSchema.parse(input),
      ),
    ),
  getContextStoreRevision: async (jobId) =>
    ContextStoreRevisionJobSchema.parse(
      await ipcRenderer.invoke("context-store-revisions:get", jobId),
    ),
  approveContextStoreRevision: async (input) =>
    ContextStoreRevisionJobSchema.parse(
      await ipcRenderer.invoke(
        "context-store-revisions:approve",
        ContextStoreRevisionJobRefSchema.parse(input),
      ),
    ),
  rejectContextStoreRevision: async (input) =>
    ContextStoreRevisionJobSchema.parse(
      await ipcRenderer.invoke(
        "context-store-revisions:reject",
        ContextStoreRevisionJobRefSchema.parse(input),
      ),
    ),
  retryContextStoreRevision: async (input) =>
    ContextStoreRevisionJobSchema.parse(
      await ipcRenderer.invoke(
        "context-store-revisions:retry",
        ContextStoreRevisionJobRefSchema.parse(input),
      ),
    ),
  deleteContextStoreRevision: async (input) => {
    await ipcRenderer.invoke(
      "context-store-revisions:delete",
      ContextStoreRevisionJobRefSchema.parse(input),
    );
  },
  createContextStoreDraft: async (input) =>
    ContextStoreDraftSchema.parse(
      await ipcRenderer.invoke(
        "context-store-drafts:create",
        CreateContextStoreDraftSchema.parse(input),
      ),
    ),
  listContextStoreDrafts: async (input = {}) =>
    ContextStoreDraftSchema.array().parse(
      await ipcRenderer.invoke(
        "context-store-drafts:list",
        ListContextStoreDraftsSchema.parse(input),
      ),
    ),
  getContextStoreDraft: async (draftId) =>
    ContextStoreDraftSchema.parse(await ipcRenderer.invoke("context-store-drafts:get", draftId)),
  getContextStoreDraftChangeSet: async (draftId) =>
    ContextStoreChangeSetSchema.parse(
      await ipcRenderer.invoke("context-store-drafts:get-change-set", draftId),
    ),
  getContextStoreDraftFile: async (input) =>
    ContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "context-store-drafts:get-file",
        GetContextStoreDraftFileSchema.parse(input),
      ),
    ),
  submitContextStoreDraft: async (input) =>
    ContextStoreDraftSchema.parse(
      await ipcRenderer.invoke(
        "context-store-drafts:submit",
        SubmitContextStoreDraftSchema.parse(input),
      ),
    ),
  updateContextStoreDraftFile: async (input) =>
    ContextStoreDraftSchema.parse(
      await ipcRenderer.invoke(
        "context-store-drafts:update-file",
        UpdateContextStoreDraftFileSchema.parse(input),
      ),
    ),
  discardContextStoreDraft: async (input) => {
    await ipcRenderer.invoke(
      "context-store-drafts:discard",
      ContextStoreDraftRefSchema.parse(input),
    );
  },
  inspectContextStoreDraftRebase: async (draftId) =>
    ContextStoreDraftRebaseInspectionSchema.parse(
      await ipcRenderer.invoke("context-store-drafts:inspect-rebase", draftId),
    ),
  rebaseContextStoreDraft: async (input) =>
    ContextStoreDraftSchema.parse(
      await ipcRenderer.invoke(
        "context-store-drafts:rebase",
        RebaseContextStoreDraftSchema.parse(input),
      ),
    ),
  getContextStoreRevisionProfile: async () =>
    ContextStoreRevisionProfileSchema.parse(
      await ipcRenderer.invoke("context-store-revisions:get-profile"),
    ),
  updateContextStoreRevisionProfile: async (input) =>
    ContextStoreRevisionProfileSchema.parse(
      await ipcRenderer.invoke(
        "context-store-revisions:update-profile",
        UpdateContextStoreRevisionProfileSchema.parse(input),
      ),
    ),
  subscribeContextStoreChanges: (storeId, listener) => {
    const input = SubscribeContextStoreChangesSchema.parse({ storeId });
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      const changed = SubscribeContextStoreChangesSchema.parse(payload);
      if (changed.storeId === storeId) listener();
    };
    ipcRenderer.on("context-stores:changed", handler);
    ipcRenderer.send("context-stores:watch", input);
    return () => {
      ipcRenderer.removeListener("context-stores:changed", handler);
      ipcRenderer.send("context-stores:unwatch", input);
    };
  },
  pickContextStoreFolder: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("context-stores:pick-folder")),
} satisfies Pick<
  PragmaDesktopAPI,
  | "listContextStores"
  | "createContextStore"
  | "inspectContextStoreImport"
  | "deleteContextStore"
  | "getContextStoreContent"
  | "listContextStoreEntries"
  | "createContextStoreFolder"
  | "createContextStoreFile"
  | "updateContextStoreFile"
  | "renameContextStoreEntry"
  | "deleteContextStoreEntry"
  | "submitContextStoreRevision"
  | "listContextStoreRevisions"
  | "getContextStoreRevision"
  | "approveContextStoreRevision"
  | "rejectContextStoreRevision"
  | "retryContextStoreRevision"
  | "deleteContextStoreRevision"
  | "createContextStoreDraft"
  | "listContextStoreDrafts"
  | "getContextStoreDraft"
  | "getContextStoreDraftChangeSet"
  | "getContextStoreDraftFile"
  | "submitContextStoreDraft"
  | "updateContextStoreDraftFile"
  | "discardContextStoreDraft"
  | "inspectContextStoreDraftRebase"
  | "rebaseContextStoreDraft"
  | "getContextStoreRevisionProfile"
  | "updateContextStoreRevisionProfile"
  | "subscribeContextStoreChanges"
  | "pickContextStoreFolder"
>;
