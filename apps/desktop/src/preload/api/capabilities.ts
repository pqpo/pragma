import { ipcRenderer } from "electron";

import {
  CapabilityActionSchema,
  CapabilityDeleteResultSchema,
  CapabilityIdSchema,
  CapabilitySchema,
  CapabilityTestRequestSchema,
  CapabilityTestResultSchema,
  CreateCapabilitySchema,
  GetSkillFileSchema,
  GetSkillDocumentSchema,
  ImportSkillCapabilitySchema,
  ListSkillFilesSchema,
  PreviewCodeServiceRequestSchema,
  PreviewCodeServiceResultSchema,
  SkillDocumentSchema,
  SkillFileContentSchema,
  SkillFileEntrySchema,
  UpdateCapabilitySchema,
  UpdateSkillCapabilitySchema,
} from "../../shared/contracts/capabilities.ts";
import { PickWorkspaceResultSchema } from "../../shared/contracts/settings.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const capabilitiesApi = {
  listCapabilities: async () =>
    CapabilitySchema.array().parse(await ipcRenderer.invoke("capabilities:list")),
  getCapability: async (id, revision) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:get", CapabilityIdSchema.parse(id), revision),
    ),
  getSkillDocument: async (input) =>
    SkillDocumentSchema.parse(
      await ipcRenderer.invoke(
        "capabilities:get-skill-document",
        GetSkillDocumentSchema.parse(input),
      ),
    ),
  listSkillFiles: async (input) =>
    SkillFileEntrySchema.array().parse(
      await ipcRenderer.invoke("capabilities:list-skill-files", ListSkillFilesSchema.parse(input)),
    ),
  getSkillFile: async (input) =>
    SkillFileContentSchema.parse(
      await ipcRenderer.invoke("capabilities:get-skill-file", GetSkillFileSchema.parse(input)),
    ),
  importSkillCapability: async (input) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke(
        "capabilities:import-skill",
        ImportSkillCapabilitySchema.parse(input),
      ),
    ),
  updateSkillCapability: async (input) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke(
        "capabilities:update-skill",
        UpdateSkillCapabilitySchema.parse(input),
      ),
    ),
  createCapability: async (input) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:create", CreateCapabilitySchema.parse(input)),
    ),
  updateCapability: async (input) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:update", UpdateCapabilitySchema.parse(input)),
    ),
  retryCapability: async (id) =>
    CapabilitySchema.parse(
      await ipcRenderer.invoke("capabilities:retry", CapabilityActionSchema.parse({ id })),
    ),
  testCapability: async (input) =>
    CapabilityTestResultSchema.parse(
      await ipcRenderer.invoke("capabilities:test", CapabilityTestRequestSchema.parse(input)),
    ),
  previewCodeService: async (input) =>
    PreviewCodeServiceResultSchema.parse(
      await ipcRenderer.invoke(
        "capabilities:preview-code",
        PreviewCodeServiceRequestSchema.parse(input),
      ),
    ),
  deleteCapability: async (id) =>
    CapabilityDeleteResultSchema.parse(
      await ipcRenderer.invoke("capabilities:delete", CapabilityActionSchema.parse({ id })),
    ),
  pickSkillSource: async () =>
    PickWorkspaceResultSchema.parse(await ipcRenderer.invoke("capabilities:pick-skill")),
} satisfies Pick<
  PragmaDesktopAPI,
  | "listCapabilities"
  | "getCapability"
  | "getSkillDocument"
  | "listSkillFiles"
  | "getSkillFile"
  | "importSkillCapability"
  | "updateSkillCapability"
  | "createCapability"
  | "updateCapability"
  | "retryCapability"
  | "testCapability"
  | "previewCodeService"
  | "deleteCapability"
  | "pickSkillSource"
>;
