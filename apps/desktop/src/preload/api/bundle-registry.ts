import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  AddDesktopBundleRegistrySourceSchema,
  DesktopBundleRegistrySourceRefSchema,
  DesktopBundleRegistrySourceStatusSchema,
  DesktopSquareBundleDownloadSchema,
  DesktopSquareCatalogSchema,
  DesktopSquareItemDetailSchema,
  DownloadDesktopSquareBundleSchema,
  GetDesktopSquareItemSchema,
  UpdateDesktopBundleRegistrySourceSchema,
} from "../../shared/contracts/index.ts";
import { invokeMutation } from "../invoke-mutation.ts";

export const bundleRegistryApi = {
  listBundleRegistrySources: async () =>
    DesktopBundleRegistrySourceStatusSchema.array().parse(
      await ipcRenderer.invoke("bundle-registry:sources:list"),
    ),
  addBundleRegistrySource: async (input) =>
    DesktopBundleRegistrySourceStatusSchema.parse(
      await invokeMutation(
        "bundle-registry:sources:add",
        AddDesktopBundleRegistrySourceSchema.parse(input),
      ),
    ),
  updateBundleRegistrySource: async (input) =>
    DesktopBundleRegistrySourceStatusSchema.parse(
      await invokeMutation(
        "bundle-registry:sources:update",
        UpdateDesktopBundleRegistrySourceSchema.parse(input),
      ),
    ),
  removeBundleRegistrySource: async (input) => {
    await invokeMutation(
      "bundle-registry:sources:remove",
      DesktopBundleRegistrySourceRefSchema.parse(input),
    );
  },
  refreshBundleRegistrySource: async (input) =>
    DesktopBundleRegistrySourceStatusSchema.parse(
      await invokeMutation(
        "bundle-registry:sources:refresh",
        DesktopBundleRegistrySourceRefSchema.parse(input),
      ),
    ),
  refreshBundleRegistrySources: async () =>
    DesktopBundleRegistrySourceStatusSchema.array().parse(
      await invokeMutation("bundle-registry:sources:refresh-all"),
    ),
  getSquareCatalog: async () =>
    DesktopSquareCatalogSchema.parse(await ipcRenderer.invoke("bundle-registry:catalog")),
  getSquareItem: async (input) =>
    DesktopSquareItemDetailSchema.parse(
      await ipcRenderer.invoke("bundle-registry:item", GetDesktopSquareItemSchema.parse(input)),
    ),
  downloadSquareBundle: async (input) =>
    DesktopSquareBundleDownloadSchema.parse(
      await invokeMutation(
        "bundle-registry:download",
        DownloadDesktopSquareBundleSchema.parse(input),
      ),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "listBundleRegistrySources"
  | "addBundleRegistrySource"
  | "updateBundleRegistrySource"
  | "removeBundleRegistrySource"
  | "refreshBundleRegistrySource"
  | "refreshBundleRegistrySources"
  | "getSquareCatalog"
  | "getSquareItem"
  | "downloadSquareBundle"
>;
