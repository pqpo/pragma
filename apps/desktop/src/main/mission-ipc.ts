import { basename } from "node:path";

import { ipcMain, type BrowserWindow } from "electron";

import {
  CreateMissionSchema,
  GetMissionChatSchema,
  GetMissionWorkConversationSchema,
  MissionActionSchema,
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionModelOptionsRequestSchema,
  MissionIdSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  UpdateMissionOptionsSchema,
} from "../shared/desktop-api.ts";
import type { MissionRunner } from "./mission-runner.ts";
import type { MissionStore } from "./mission-store.ts";
import type { DesktopToolPermissionMode } from "../shared/desktop-api.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";
import { availableRecentWorkspaces } from "./workspace-history-store.ts";
import { validateWorkspace } from "./workspace-scope.ts";

export function installMissionHandlers(options: {
  readonly missions: MissionStore;
  readonly project: PragmaProjectStore;
  readonly executors: MissionExecutorCatalog;
  readonly runner: MissionRunner;
  readonly getWindow: () => BrowserWindow | null;
  readonly getDefaultToolPermissionMode: () =>
    | DesktopToolPermissionMode
    | Promise<DesktopToolPermissionMode>;
  readonly getDefaultWorkspace: () => string | Promise<string>;
  readonly getRecentWorkspaces: () => readonly string[] | Promise<readonly string[]>;
  readonly recordWorkspaceUsage: (path: string) => void | Promise<void>;
  readonly defaultExecutorRef: string;
}): void {
  ipcMain.handle("missions:list", () => options.missions.list());
  ipcMain.handle("missions:get", (_event, id: unknown) =>
    options.missions.get(MissionIdSchema.parse(id)),
  );
  ipcMain.handle("missions:executors:list", async () =>
    MissionExecutorOptionSchema.array().parse(await options.executors.list()),
  );
  ipcMain.handle("missions:model-options:get", async (_event, input: unknown) => {
    const { executorRef, missionId } = MissionModelOptionsRequestSchema.parse(input);
    const runtimeBinding =
      missionId === undefined ? undefined : await options.runner.getRuntimeBinding(missionId);
    return await options.executors.getModelOptions(executorRef, runtimeBinding);
  });
  ipcMain.handle("missions:create-defaults:get", async () => {
    const workspace = await options.getDefaultWorkspace();
    const recentWorkspaces = await availableRecentWorkspaces(
      await options.getRecentWorkspaces(),
      workspace,
      async (path) => (await validateWorkspace(path)).ok,
    );
    return MissionCreationDefaultsSchema.parse({
      workspace: { path: workspace, basename: basename(workspace) },
      recentWorkspaces: recentWorkspaces.map((path) => ({ path, basename: basename(path) })),
      executorRef: options.defaultExecutorRef,
      toolPermissionMode: await options.getDefaultToolPermissionMode(),
    });
  });
  ipcMain.handle("missions:create", async (_event, input: unknown) => {
    const parsed = CreateMissionSchema.parse(input);
    const validation = await validateWorkspace(parsed.workspace);
    if (!validation.ok) {
      throw new Error("The selected workspace must be an accessible, writable directory.");
    }
    const snapshot = await options.project.get();
    const executor = await options.executors.resolve(parsed.executor.ref);
    if (executor === undefined)
      throw new Error(`Mission executor not found: ${parsed.executor.ref}`);
    if (executor.kind === "flow" && parsed.modelOverride !== undefined) {
      throw new Error("Flow missions do not support a model override.");
    }
    if (parsed.modelOverride !== undefined) {
      await options.executors.validateModelOverride(executor.ref, parsed.modelOverride);
    }
    const mission = await options.missions.create({
      workspace: { path: parsed.workspace, basename: basename(parsed.workspace) },
      goal: parsed.goal,
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor,
      ...(parsed.modelOverride === undefined ? {} : { modelOverride: parsed.modelOverride }),
      toolPermissionMode:
        parsed.toolPermissionMode ?? (await options.getDefaultToolPermissionMode()),
    });
    await options.recordWorkspaceUsage(parsed.workspace);
    void options.runner
      .summarizeTitle(mission.id)
      .then((updated) => options.getWindow()?.webContents.send("missions:updated", updated))
      .catch((error: unknown) => {
        console.warn(`Failed to summarize Mission title ${mission.id}.`, error);
      });
    return mission;
  });
  ipcMain.handle("missions:run", (_event, input: unknown) =>
    options.runner.run(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:options:update", (_event, input: unknown) =>
    options.runner.updateOptions(UpdateMissionOptionsSchema.parse(input)),
  );
  ipcMain.handle("missions:message:send", (_event, input: unknown) =>
    options.runner.sendMessage(SendMissionMessageSchema.parse(input)),
  );
  ipcMain.handle("missions:chat:get", (_event, input: unknown) =>
    options.runner.getChat(GetMissionChatSchema.parse(input)),
  );
  ipcMain.handle("missions:interrupt", (_event, input: unknown) =>
    options.runner.interrupt(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:work:get", (_event, input: unknown) =>
    options.runner.getWork(MissionActionSchema.parse(input).id),
  );
  ipcMain.handle("missions:work:conversation:get", (_event, input: unknown) =>
    options.runner.getWorkConversation(GetMissionWorkConversationSchema.parse(input)),
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
  options.runner.subscribeChat((update) => {
    options.getWindow()?.webContents.send("missions:chat:updated", update);
  });
  options.runner.subscribeWork((update) => {
    options.getWindow()?.webContents.send("missions:work:updated", update);
  });
}
