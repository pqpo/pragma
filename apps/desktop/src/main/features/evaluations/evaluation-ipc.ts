import { ipcMain } from "electron";
import { parsePragmaYaml } from "@pragma/interpreter";
import { PragmaAgentJudgeEvaluationResourceSchema } from "@pragma/interpreter/ast";

import {
  AgentEvaluationRunRefSchema,
  CreateAgentEvaluationRunSchema,
  ImportAgentEvaluationDatasetYamlSchema,
  RetryAgentEvaluationTaskSchema,
  UpdateEvaluationQueueSettingsSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import type { EvaluationService } from "./evaluation-service.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

export function installEvaluationHandlers(
  service: EvaluationService,
  project: PragmaProjectStore,
): void {
  ipcMain.handle("evaluations:settings:get", () =>
    runDesktopMutation(async () => await service.getSettings()),
  );
  ipcMain.handle("evaluations:settings:update", (_event, input: unknown) =>
    runDesktopMutation(
      async () => await service.updateSettings(UpdateEvaluationQueueSettingsSchema.parse(input)),
    ),
  );
  ipcMain.handle("evaluations:runs:create", (_event, input: unknown) =>
    runDesktopMutation(
      async () => await service.createRun(CreateAgentEvaluationRunSchema.parse(input)),
    ),
  );
  ipcMain.handle("evaluations:runs:list", () =>
    runDesktopMutation(async () => await service.listRuns()),
  );
  ipcMain.handle("evaluations:runs:get", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const { id } = AgentEvaluationRunRefSchema.parse(input);
      return await service.getRun(id);
    }),
  );
  ipcMain.handle("evaluations:runs:cancel", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const { id } = AgentEvaluationRunRefSchema.parse(input);
      return await service.cancelRun(id);
    }),
  );
  ipcMain.handle("evaluations:tasks:retry", (_event, input: unknown) =>
    runDesktopMutation(
      async () => await service.retryTask(RetryAgentEvaluationTaskSchema.parse(input)),
    ),
  );
  ipcMain.handle("evaluations:datasets:import-yaml", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const request = ImportAgentEvaluationDatasetYamlSchema.parse(input);
      const resource = PragmaAgentJudgeEvaluationResourceSchema.parse(
        parsePragmaYaml(request.source),
      );
      return await project.upsert({
        baseRevision: request.baseRevision,
        resource,
        requiredUnchangedRefs: [],
      });
    }),
  );
}
