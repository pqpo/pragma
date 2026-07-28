import { ipcRenderer } from "electron";

import {
  AllocatePragmaResourceIdResultSchema,
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PragmaProjectChangesValidationResultSchema,
  PragmaProjectSnapshotSchema,
  PragmaFlowRunDrySuiteResultSchema,
  PragmaYamlValidationResultSchema,
  PublishPragmaProjectSchema,
  RunPragmaFlowDrySuiteSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaResourceSchema,
  ValidatePragmaYamlSchema,
} from "../../shared/contracts/projects.ts";
import {
  DeleteWorkflowLayoutSchema,
  GetWorkflowLayoutSchema,
  WorkflowLayoutSchema,
} from "../../shared/contracts/workflow-layout.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import { invokeMutation } from "../invoke-mutation.ts";
export const projectsApi = {
  getPragmaProject: async () =>
    PragmaProjectSnapshotSchema.parse(await ipcRenderer.invoke("pragma-project:get")),
  allocatePragmaResourceId: async () =>
    AllocatePragmaResourceIdResultSchema.parse(
      await ipcRenderer.invoke("pragma-project:allocate-id"),
    ),
  publishPragmaProject: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:publish", PublishPragmaProjectSchema.parse(input)),
    ),
  upsertPragmaResource: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:upsert", UpsertPragmaResourceSchema.parse(input)),
    ),
  applyPragmaProjectChanges: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:apply-changes", PragmaProjectChangesSchema.parse(input)),
    ),
  deletePragmaResource: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:delete", DeletePragmaResourceSchema.parse(input)),
    ),
  validatePragmaYaml: async (source) =>
    PragmaYamlValidationResultSchema.parse(
      await ipcRenderer.invoke(
        "pragma-project:validate-yaml",
        ValidatePragmaYamlSchema.parse({ source }),
      ),
    ),
  validatePragmaResource: async (input) =>
    PragmaYamlValidationResultSchema.parse(
      await invokeMutation(
        "pragma-project:validate-resource",
        ValidatePragmaResourceSchema.parse(input),
      ),
    ),
  validatePragmaProjectChanges: async (input) =>
    PragmaProjectChangesValidationResultSchema.parse(
      await invokeMutation(
        "pragma-project:validate-changes",
        PragmaProjectChangesSchema.parse(input),
      ),
    ),
  runPragmaFlowDrySuite: async (input) =>
    PragmaFlowRunDrySuiteResultSchema.parse(
      await ipcRenderer.invoke(
        "pragma-project:flow:run-dry",
        RunPragmaFlowDrySuiteSchema.parse(input),
      ),
    ),
  getWorkflowLayout: async (input) => {
    const result: unknown = await ipcRenderer.invoke(
      "workflow-layout:get",
      GetWorkflowLayoutSchema.parse(input),
    );
    return result === null ? null : WorkflowLayoutSchema.parse(result);
  },
  saveWorkflowLayout: async (layout) =>
    WorkflowLayoutSchema.parse(
      await ipcRenderer.invoke("workflow-layout:save", WorkflowLayoutSchema.parse(layout)),
    ),
  deleteWorkflowLayout: async (input) => {
    await ipcRenderer.invoke("workflow-layout:delete", DeleteWorkflowLayoutSchema.parse(input));
  },
} satisfies Pick<
  PragmaDesktopAPI,
  | "getPragmaProject"
  | "allocatePragmaResourceId"
  | "publishPragmaProject"
  | "upsertPragmaResource"
  | "applyPragmaProjectChanges"
  | "deletePragmaResource"
  | "validatePragmaYaml"
  | "validatePragmaResource"
  | "validatePragmaProjectChanges"
  | "runPragmaFlowDrySuite"
  | "getWorkflowLayout"
  | "saveWorkflowLayout"
  | "deleteWorkflowLayout"
>;
