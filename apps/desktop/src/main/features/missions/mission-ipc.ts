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
  type DesktopToolPermissionMode,
} from "../../../shared/contracts/index.ts";
import type { MissionRunner } from "./mission-runner.ts";
import type { MissionStore } from "./mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";
import type { MissionCreator } from "./mission-creator.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import { publishMissionUpdate } from "./mission-update-publisher.ts";
import { availableRecentWorkspaces } from "../workspaces/workspace-history-store.ts";
import { validateWorkspace } from "../workspaces/workspace-scope.ts";

export function installMissionHandlers(options: {
  readonly missions: MissionStore;
  readonly creator: MissionCreator;
  readonly executors: MissionExecutorCatalog;
  readonly project: PragmaProjectStore;
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
  const publishMission = (mission: Awaited<ReturnType<MissionStore["get"]>>): void => {
    publishMissionUpdate(() => options.getWindow()?.webContents ?? null, {
      kind: "upsert",
      mission,
    });
  };
  const publishRemoval = (missionId: string): void => {
    publishMissionUpdate(() => options.getWindow()?.webContents ?? null, {
      kind: "remove",
      missionId,
    });
  };
  ipcMain.handle("missions:list", () => options.missions.list());
  ipcMain.handle("missions:get", (_event, id: unknown) =>
    options.missions.get(MissionIdSchema.parse(id)),
  );
  ipcMain.handle("missions:executors:list", async () =>
    MissionExecutorOptionSchema.array().parse(await options.executors.list()),
  );
  ipcMain.handle("missions:model-options:get", async (_event, input: unknown) => {
    const { executorRef, missionId } = MissionModelOptionsRequestSchema.parse(input);
    if (missionId === undefined) return await options.executors.getModelOptions(executorRef);
    const mission = await options.missions.get(missionId);
    const [runtimeBinding, project] = await Promise.all([
      options.runner.getRuntimeBinding(missionId),
      options.project.openRevision(mission.project.revision),
    ]);
    return await options.executors.getModelOptions(
      executorRef,
      runtimeBinding,
      project.listResources(),
    );
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
    const mission = await options.creator.create({
      workspace: parsed.workspace,
      missionInput: parsed.input,
      executorRef: parsed.executor.ref,
      ...(parsed.modelOverride === undefined ? {} : { modelOverride: parsed.modelOverride }),
      ...(parsed.toolPermissionMode === undefined
        ? {}
        : { toolPermissionMode: parsed.toolPermissionMode }),
    });
    await options.recordWorkspaceUsage(parsed.workspace);
    publishMission(mission);
    return mission;
  });
  ipcMain.handle("missions:run", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const mission = await options.runner.run(MissionActionSchema.parse(input).id);
      publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:options:update", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const mission = await options.runner.updateOptions(UpdateMissionOptionsSchema.parse(input));
      publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:message:send", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const mission = await options.runner.sendMessage(SendMissionMessageSchema.parse(input));
      publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:chat:get", (_event, input: unknown) =>
    options.runner.getChat(GetMissionChatSchema.parse(input)),
  );
  ipcMain.handle("missions:context:compact", (_event, input: unknown) =>
    runDesktopMutation(() => options.runner.compactContext(MissionActionSchema.parse(input).id)),
  );
  ipcMain.handle("missions:interrupt", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const mission = await options.runner.interrupt(MissionActionSchema.parse(input).id);
      publishMission(mission);
      return mission;
    }),
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
    return await runDesktopMutation(() =>
      options.runner.respondToHumanInteraction(RespondMissionHumanInteractionSchema.parse(input)),
    );
  });
  ipcMain.handle("missions:complete", async (_event, input: unknown) => {
    const mission = await options.missions.markComplete(MissionActionSchema.parse(input).id);
    publishMission(mission);
    return mission;
  });
  ipcMain.handle("missions:reopen", async (_event, input: unknown) => {
    const mission = await options.missions.reopen(MissionActionSchema.parse(input).id);
    publishMission(mission);
    return mission;
  });
  ipcMain.handle("missions:delete", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const missionId = MissionActionSchema.parse(input).id;
      await options.runner.delete(missionId);
      publishRemoval(missionId);
    }),
  );
  options.runner.subscribeChat((update) => {
    options.getWindow()?.webContents.send("missions:chat:updated", update);
    if (update.kind === "invalidate") {
      void options.missions
        .get(update.missionId)
        .then(publishMission)
        .catch(() => undefined);
    }
  });
  options.runner.subscribeWork((update) => {
    options.getWindow()?.webContents.send("missions:work:updated", update);
  });
}
