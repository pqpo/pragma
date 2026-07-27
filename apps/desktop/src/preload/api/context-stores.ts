import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
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
  | "subscribeContextStoreChanges"
  | "pickContextStoreFolder"
>;
