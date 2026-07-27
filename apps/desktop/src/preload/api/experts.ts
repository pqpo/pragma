import { ipcRenderer } from "electron";

import {
  CreateExpertDefinitionSchema,
  DeleteExpertDefinitionSchema,
  ExpertDefinitionSchema,
  ExpertRefSchema,
  ExpertSummarySchema,
  ResetBuiltInExpertDefinitionSchema,
  UpdateBuiltInExpertDefinitionSchema,
  UpdateExpertDefinitionSchema,
} from "../../shared/contracts/experts.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import { invokeMutation } from "../invoke-mutation.ts";
export const expertsApi = {
  listExperts: async () =>
    ExpertSummarySchema.array().parse(await ipcRenderer.invoke("experts:list")),
  getExpert: async (ref) =>
    ExpertDefinitionSchema.parse(
      await ipcRenderer.invoke("experts:get", ExpertRefSchema.parse(ref)),
    ),
  createExpert: async (input) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation("experts:create", CreateExpertDefinitionSchema.parse(input)),
    ),
  updateExpert: async (ref, input) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation(
        "experts:update",
        ExpertRefSchema.parse(ref),
        UpdateExpertDefinitionSchema.parse(input),
      ),
    ),
  updateBuiltInExpert: async (ref, input) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation(
        "experts:update-built-in",
        ExpertRefSchema.parse(ref),
        UpdateBuiltInExpertDefinitionSchema.parse(input),
      ),
    ),
  resetBuiltInExpert: async (ref) =>
    ExpertDefinitionSchema.parse(
      await invokeMutation(
        "experts:reset-built-in",
        ResetBuiltInExpertDefinitionSchema.parse({ ref }),
      ),
    ),
  deleteExpert: async (ref) => {
    await invokeMutation("experts:delete", DeleteExpertDefinitionSchema.parse({ ref }));
  },
} satisfies Pick<
  PragmaDesktopAPI,
  | "listExperts"
  | "getExpert"
  | "createExpert"
  | "updateExpert"
  | "updateBuiltInExpert"
  | "resetBuiltInExpert"
  | "deleteExpert"
>;
