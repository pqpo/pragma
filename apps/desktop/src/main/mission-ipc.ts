import { basename } from "node:path";

import { ipcMain } from "electron";

import {
  CreateMissionSchema,
  MissionActionSchema,
  MissionIdSchema,
} from "../shared/desktop-api.ts";
import type { ExpertDefinitionStore } from "./expert-definition-store.ts";
import type { MissionStore } from "./mission-store.ts";
import { validateWorkspace } from "./workspace-scope.ts";

export function installMissionHandlers(options: {
  readonly missions: MissionStore;
  readonly experts: ExpertDefinitionStore;
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
    const expert = await options.experts.get(parsed.executor.id);
    return await options.missions.create({
      workspace: { path: parsed.workspace, basename: basename(parsed.workspace) },
      goal: parsed.goal,
      expert,
    });
  });
  ipcMain.handle("missions:complete", (_event, input: unknown) =>
    options.missions.markComplete(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:reopen", (_event, input: unknown) =>
    options.missions.reopen(MissionActionSchema.parse(input).id),
  );
}
