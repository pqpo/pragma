import { basename } from "node:path";

import { ipcMain, type BrowserWindow } from "electron";

import {
  CreateMissionSchema,
  GetMissionChatSchema,
  GetMissionWorkConversationSchema,
  HomeExecutorPreferenceSchema,
  HomeMissionExecutorCatalogSchema,
  MissionActionSchema,
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionModelOptionsRequestSchema,
  MissionIdSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  UpdateMissionOptionsSchema,
  UpdateHomeExecutorPreferenceSchema,
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
import type { HomeExecutorCatalog } from "./home-executor-catalog.ts";

export function installMissionHandlers(options: {
  readonly missions: MissionStore;
  readonly creator: MissionCreator;
  readonly executors: MissionExecutorCatalog;
  readonly homeExecutors: HomeExecutorCatalog;
  readonly project: PragmaProjectStore;
  readonly runner: MissionRunner;
  readonly getWindow: () => BrowserWindow | null;
  readonly getDefaultToolPermissionMode: () =>
    DesktopToolPermissionMode | Promise<DesktopToolPermissionMode>;
  readonly getDefaultWorkspace: () => string | Promise<string>;
  readonly getRecentWorkspaces: () => readonly string[] | Promise<readonly string[]>;
  readonly recordWorkspaceUsage: (path: string) => void | Promise<void>;
  readonly defaultExecutorRef: string;
  readonly onMissionLifecycleChange?:
    | ((input: {
        readonly missionId: string;
        readonly state: "active" | "completed";
      }) => Promise<void>)
    | undefined;
}): void {
  const getCreationDefaults = async () => {
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
  };
  const publishMission = (mission: Awaited<ReturnType<MissionStore["get"]>>): void => {
    if (mission.origin.type !== "user") return;
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
  const getUserMission = async (id: string) => {
    const mission = await options.missions.get(id);
    if (mission.origin.type !== "user") throw new Error("mission_not_found");
    return mission;
  };
  const assertUserMission = async (id: string): Promise<string> => {
    await getUserMission(id);
    return id;
  };
  ipcMain.handle("missions:list", () => options.missions.list());
  ipcMain.handle("missions:get", (_event, id: unknown) =>
    getUserMission(MissionIdSchema.parse(id)),
  );
  ipcMain.handle("missions:executors:list", async () =>
    MissionExecutorOptionSchema.array().parse(await options.executors.list()),
  );
  ipcMain.handle("missions:home-executors:get", async () =>
    HomeMissionExecutorCatalogSchema.parse({
      executors: await options.homeExecutors.list(),
      defaults: await getCreationDefaults(),
    }),
  );
  ipcMain.handle("missions:home-executor-preference:update", (_event, input: unknown) =>
    runDesktopMutation(async () =>
      HomeExecutorPreferenceSchema.parse(
        await options.homeExecutors.update(UpdateHomeExecutorPreferenceSchema.parse(input)),
      ),
    ),
  );
  ipcMain.handle("missions:model-options:get", async (_event, input: unknown) => {
    const { executorRef, missionId } = MissionModelOptionsRequestSchema.parse(input);
    if (missionId === undefined) return await options.executors.getModelOptions(executorRef);
    const mission = await getUserMission(missionId);
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
  ipcMain.handle("missions:create-defaults:get", getCreationDefaults);
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
    await Promise.all([
      options.recordWorkspaceUsage(parsed.workspace),
      options.homeExecutors.recordUsage(parsed.executor.ref, parsed.workspace),
    ]);
    publishMission(mission);
    return mission;
  });
  ipcMain.handle("missions:run", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const mission = await options.runner.run(
        await assertUserMission(MissionActionSchema.parse(input).id),
      );
      publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:options:update", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = UpdateMissionOptionsSchema.parse(input);
      await assertUserMission(parsed.id);
      const mission = await options.runner.updateOptions(parsed);
      publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:message:send", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = SendMissionMessageSchema.parse(input);
      await assertUserMission(parsed.id);
      const mission = await options.runner.sendMessage(parsed);
      publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:chat:get", async (_event, input: unknown) => {
    const parsed = GetMissionChatSchema.parse(input);
    await assertUserMission(parsed.id);
    return await options.runner.getChat(parsed);
  });
  ipcMain.handle("missions:context:compact", (_event, input: unknown) =>
    runDesktopMutation(
      async () =>
        await options.runner.compactContext(
          await assertUserMission(MissionActionSchema.parse(input).id),
        ),
    ),
  );
  ipcMain.handle("missions:interrupt", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const mission = await options.runner.interrupt(
        await assertUserMission(MissionActionSchema.parse(input).id),
      );
      publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle(
    "missions:work:get",
    async (_event, input: unknown) =>
      await options.runner.getWork(await assertUserMission(MissionActionSchema.parse(input).id)),
  );
  ipcMain.handle("missions:work:conversation:get", async (_event, input: unknown) => {
    const parsed = GetMissionWorkConversationSchema.parse(input);
    await assertUserMission(parsed.id);
    return await options.runner.getWorkConversation(parsed);
  });
  ipcMain.handle(
    "missions:human:list",
    async (_event, input: unknown) =>
      await options.runner.listHumanInteractions(
        await assertUserMission(MissionActionSchema.parse(input).id),
      ),
  );
  ipcMain.handle("missions:human:respond", async (_event, input: unknown) => {
    return await runDesktopMutation(async () => {
      const parsed = RespondMissionHumanInteractionSchema.parse(input);
      await assertUserMission(parsed.missionId);
      return await options.runner.respondToHumanInteraction(parsed);
    });
  });
  ipcMain.handle("missions:complete", async (_event, input: unknown) => {
    const missionId = await assertUserMission(MissionActionSchema.parse(input).id);
    const mission = await options.missions.markComplete(missionId);
    if (
      mission.origin.type === "user" &&
      !(
        mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status)
      )
    ) {
      await options.onMissionLifecycleChange?.({
        missionId: mission.id,
        state: "completed",
      });
    }
    publishMission(mission);
    return mission;
  });
  ipcMain.handle("missions:reopen", async (_event, input: unknown) => {
    const missionId = await assertUserMission(MissionActionSchema.parse(input).id);
    const mission = await options.missions.reopen(missionId);
    if (mission.origin.type === "user") {
      await options.onMissionLifecycleChange?.({ missionId: mission.id, state: "active" });
    }
    publishMission(mission);
    return mission;
  });
  ipcMain.handle("missions:delete", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const missionId = MissionActionSchema.parse(input).id;
      await assertUserMission(missionId);
      await options.runner.delete(missionId);
      publishRemoval(missionId);
    }),
  );
  options.runner.subscribeChat((update) => {
    void getUserMission(update.missionId)
      .then((mission) => {
        options.getWindow()?.webContents.send("missions:chat:updated", update);
        if (update.kind === "invalidate") publishMission(mission);
      })
      .catch(() => undefined);
  });
  options.runner.subscribeWork((update) => {
    void getUserMission(update.missionId)
      .then(() => options.getWindow()?.webContents.send("missions:work:updated", update))
      .catch(() => undefined);
  });
}
