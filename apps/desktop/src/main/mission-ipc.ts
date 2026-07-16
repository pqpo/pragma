import { basename } from "node:path";

import { ipcMain } from "electron";

import {
  CreateMissionSchema,
  MissionActionSchema,
  MissionIdSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
} from "../shared/desktop-api.ts";
import type { MissionRunner } from "./mission-runner.ts";
import type { MissionStore } from "./mission-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import { validateWorkspace } from "./workspace-scope.ts";

export function installMissionHandlers(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly runner: MissionRunner;
}): void {
  ipcMain.handle("missions:list", () => options.missions.list());
  ipcMain.handle("missions:get", (_event, id: unknown) =>
    options.missions.get(MissionIdSchema.parse(id)),
  );
  ipcMain.handle("missions:create", async (_event, input: unknown) => {
    const parsed = CreateMissionSchema.parse(input);
    const validation = await validateWorkspace(parsed.workspace);
    if (!validation.ok) {
      throw new Error("The selected workspace must be an accessible, writable directory.");
    }
    const snapshot = await options.project.get();
    const executor = snapshot.resources.find((resource) => {
      const kind =
        resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : "flow";
      return `${kind}:${resource.metadata.id}@${resource.metadata.version}` === parsed.executor.ref;
    });
    if (executor === undefined)
      throw new Error(`Mission executor not found: ${parsed.executor.ref}`);
    return await options.missions.create({
      workspace: { path: parsed.workspace, basename: basename(parsed.workspace) },
      goal: parsed.goal,
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor,
    });
  });
  ipcMain.handle("missions:run", (_event, input: unknown) =>
    options.runner.run(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:message:send", (_event, input: unknown) =>
    options.runner.sendMessage(SendMissionMessageSchema.parse(input)),
  );
  ipcMain.handle("missions:work:list", (_event, input: unknown) =>
    options.runner.listWorkItems(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:human:list", (_event, input: unknown) =>
    options.runner.listHumanInteractions(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:human:respond", async (_event, input: unknown) => {
    await options.runner.respondToHumanInteraction(
      RespondMissionHumanInteractionSchema.parse(input),
    );
  });
  ipcMain.handle("missions:complete", (_event, input: unknown) =>
    options.missions.markComplete(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:reopen", (_event, input: unknown) =>
    options.missions.reopen(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:delete", (_event, input: unknown) =>
    options.runner.delete(MissionActionSchema.parse(input).id),
  );
}
