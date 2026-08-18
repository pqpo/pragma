import { ipcRenderer, webUtils } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  ExportPragmaBundleSchema,
  InspectPragmaBundleSchema,
  PreparePragmaBundleExportSchema,
  PragmaBundleExportPreviewSchema,
  PragmaBundleExportResultSchema,
  PragmaBundleImportInspectionSchema,
  PragmaBundlePickResultSchema,
  PragmaBundleInstallationActionSchema,
  PragmaBundleInstallationSchema,
  RecheckPragmaBundleInstallationSchema,
  ResolvePragmaBundleInstallationSchema,
  StartPragmaBundleImportSchema,
} from "../../shared/contracts/index.ts";
import { invokeMutation } from "../invoke-mutation.ts";

export const bundlesApi = {
  preparePragmaBundleExport: async (input) =>
    PragmaBundleExportPreviewSchema.parse(
      await ipcRenderer.invoke(
        "pragma-bundles:export:prepare",
        PreparePragmaBundleExportSchema.parse(input),
      ),
    ),
  exportPragmaBundle: async (input) =>
    PragmaBundleExportResultSchema.parse(
      await invokeMutation("pragma-bundles:export", ExportPragmaBundleSchema.parse(input)),
    ),
  pickPragmaBundle: async () =>
    PragmaBundlePickResultSchema.parse(await ipcRenderer.invoke("pragma-bundles:pick")),
  inspectPragmaBundle: async (input) =>
    PragmaBundleImportInspectionSchema.parse(
      await ipcRenderer.invoke("pragma-bundles:inspect", InspectPragmaBundleSchema.parse(input)),
    ),
  inspectDroppedPragmaBundle: async (file) => {
    const sourcePath = webUtils.getPathForFile(file);
    if (sourcePath === "") throw new Error("The dropped file is not backed by a local file.");
    return PragmaBundleImportInspectionSchema.parse(
      await ipcRenderer.invoke(
        "pragma-bundles:inspect",
        InspectPragmaBundleSchema.parse({ sourcePath }),
      ),
    );
  },
  importPragmaBundle: async (input) =>
    PragmaBundleInstallationSchema.parse(
      await invokeMutation("pragma-bundles:import", StartPragmaBundleImportSchema.parse(input)),
    ),
  listPragmaBundleInstallations: async () =>
    PragmaBundleInstallationSchema.array().parse(
      await ipcRenderer.invoke("pragma-bundles:installations:list"),
    ),
  resolvePragmaBundleInstallation: async (input) =>
    PragmaBundleInstallationSchema.parse(
      await invokeMutation(
        "pragma-bundles:installation:resolve",
        ResolvePragmaBundleInstallationSchema.parse(input),
      ),
    ),
  recheckPragmaBundleInstallation: async (input) =>
    PragmaBundleInstallationSchema.parse(
      await invokeMutation(
        "pragma-bundles:installation:recheck",
        RecheckPragmaBundleInstallationSchema.parse(input),
      ),
    ),
  discardPragmaBundleInstallation: async (input) => {
    await invokeMutation(
      "pragma-bundles:installation:discard",
      PragmaBundleInstallationActionSchema.parse(input),
    );
  },
} satisfies Pick<
  PragmaDesktopAPI,
  | "preparePragmaBundleExport"
  | "exportPragmaBundle"
  | "pickPragmaBundle"
  | "inspectPragmaBundle"
  | "inspectDroppedPragmaBundle"
  | "importPragmaBundle"
  | "listPragmaBundleInstallations"
  | "recheckPragmaBundleInstallation"
  | "resolvePragmaBundleInstallation"
  | "discardPragmaBundleInstallation"
>;
