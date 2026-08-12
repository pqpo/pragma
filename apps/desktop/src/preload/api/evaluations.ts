import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  AgentEvaluationRunRefSchema,
  AgentEvaluationRunSchema,
  CreateAgentEvaluationRunSchema,
  EvaluationQueueSettingsSchema,
  ImportAgentEvaluationDatasetYamlSchema,
  RetryAgentEvaluationTaskSchema,
  UpdateEvaluationQueueSettingsSchema,
} from "../../shared/contracts/evaluations.ts";
import { PragmaProjectSnapshotSchema } from "../../shared/contracts/projects.ts";

export const evaluationsApi = {
  getEvaluationQueueSettings: async () =>
    EvaluationQueueSettingsSchema.parse(await ipcRenderer.invoke("evaluations:settings:get")),
  updateEvaluationQueueSettings: async (input) =>
    EvaluationQueueSettingsSchema.parse(
      await ipcRenderer.invoke(
        "evaluations:settings:update",
        UpdateEvaluationQueueSettingsSchema.parse(input),
      ),
    ),
  createAgentEvaluationRun: async (input) =>
    AgentEvaluationRunSchema.parse(
      await ipcRenderer.invoke(
        "evaluations:runs:create",
        CreateAgentEvaluationRunSchema.parse(input),
      ),
    ),
  listAgentEvaluationRuns: async () =>
    AgentEvaluationRunSchema.array().parse(await ipcRenderer.invoke("evaluations:runs:list")),
  getAgentEvaluationRun: async (input) =>
    AgentEvaluationRunSchema.parse(
      await ipcRenderer.invoke("evaluations:runs:get", AgentEvaluationRunRefSchema.parse(input)),
    ),
  cancelAgentEvaluationRun: async (input) =>
    AgentEvaluationRunSchema.parse(
      await ipcRenderer.invoke("evaluations:runs:cancel", AgentEvaluationRunRefSchema.parse(input)),
    ),
  retryAgentEvaluationTask: async (input) =>
    AgentEvaluationRunSchema.parse(
      await ipcRenderer.invoke(
        "evaluations:tasks:retry",
        RetryAgentEvaluationTaskSchema.parse(input),
      ),
    ),
  importAgentEvaluationDatasetYaml: async (input) =>
    PragmaProjectSnapshotSchema.parse(
      await ipcRenderer.invoke(
        "evaluations:datasets:import-yaml",
        ImportAgentEvaluationDatasetYamlSchema.parse(input),
      ),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "getEvaluationQueueSettings"
  | "updateEvaluationQueueSettings"
  | "createAgentEvaluationRun"
  | "listAgentEvaluationRuns"
  | "getAgentEvaluationRun"
  | "cancelAgentEvaluationRun"
  | "retryAgentEvaluationTask"
  | "importAgentEvaluationDatasetYaml"
>;
