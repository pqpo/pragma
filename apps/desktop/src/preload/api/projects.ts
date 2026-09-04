import { ipcRenderer } from "electron";
import { PragmaFlowRunDrySuiteResultSchema } from "@pragma/evaluation/ast";

import {
  AllocatePragmaResourceIdResultSchema,
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PragmaProjectChangesValidationResultSchema,
  PragmaProjectSnapshotSchema,
  PragmaYamlValidationResultSchema,
  PublishPragmaProjectSchema,
  RunPragmaEvaluationSchema,
  UpsertPragmaResourceSchema,
  UpsertPragmaExpertTeamSchema,
  DesktopPragmaContextStoreBindingSchema,
  EnsurePragmaContextStoreBindingSchema,
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
    PragmaProjectSnapshotSchema.parse(await invokeMutation("pragma-project:get")),
  allocatePragmaResourceId: async () =>
    AllocatePragmaResourceIdResultSchema.parse(await invokeMutation("pragma-project:allocate-id")),
  publishPragmaProject: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:publish", PublishPragmaProjectSchema.parse(input)),
    ),
  upsertPragmaResource: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:upsert", UpsertPragmaResourceSchema.parse(input)),
    ),
  upsertPragmaExpertTeam: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await invokeMutation("pragma-project:upsert-team", UpsertPragmaExpertTeamSchema.parse(input)),
    ),
  listPragmaContextStoreBindings: async () =>
    DesktopPragmaContextStoreBindingSchema.array().parse(
      await invokeMutation("pragma-project:context-store-bindings"),
    ),
  ensurePragmaContextStoreBinding: async (input) =>
    DesktopPragmaContextStoreBindingSchema.parse(
      await invokeMutation(
        "pragma-project:ensure-context-store-binding",
        EnsurePragmaContextStoreBindingSchema.parse(input),
      ),
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
  runPragmaEvaluation: async (input) =>
    PragmaFlowRunDrySuiteResultSchema.parse(
      await invokeMutation("pragma-project:evaluation:run", RunPragmaEvaluationSchema.parse(input)),
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
  | "upsertPragmaExpertTeam"
  | "listPragmaContextStoreBindings"
  | "ensurePragmaContextStoreBinding"
  | "applyPragmaProjectChanges"
  | "deletePragmaResource"
  | "validatePragmaYaml"
  | "validatePragmaResource"
  | "validatePragmaProjectChanges"
  | "runPragmaEvaluation"
  | "getWorkflowLayout"
  | "saveWorkflowLayout"
  | "deleteWorkflowLayout"
>;
