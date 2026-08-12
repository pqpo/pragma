import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from "electron";

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
  PickMissionAttachmentsResultSchema,
  PickMissionAttachmentsSchema,
  StageMissionClipboardImageSchema,
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
import { installMissionAttachmentProtocol } from "./mission-attachment-protocol.ts";
import {
  forwardMissionChatNotification,
  forwardMissionWorkNotification,
} from "./mission-renderer-update-forwarder.ts";

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
  readonly temporaryRoot: string;
  readonly onMissionLifecycleChange?:
    | ((input: {
        readonly missionId: string;
        readonly state: "active" | "completed";
      }) => Promise<void>)
    | undefined;
}): void {
  installMissionAttachmentProtocol(options.missions);
  const stagedClipboardImages = new Set<string>();
  const cleanupStagedClipboardImages = async (
    attachments: readonly { readonly path: string }[],
  ): Promise<void> => {
    await Promise.all(
      attachments.map(async ({ path }) => {
        if (!stagedClipboardImages.delete(path)) return;
        await rm(path, { force: true });
      }),
    );
  };
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
  ipcMain.handle("missions:attachments:pick", async (_event, input: unknown) => {
    const parsed = PickMissionAttachmentsSchema.parse(input);
    const dialogOptions = attachmentDialogOptions(parsed.kind);
    const window = options.getWindow();
    const result =
      window === null
        ? await dialog.showOpenDialog(dialogOptions)
        : await dialog.showOpenDialog(window, dialogOptions);
    if (result.canceled) {
      return PickMissionAttachmentsResultSchema.parse({ attachments: [] });
    }
    const attachments = await Promise.all(
      result.filePaths.map(async (path) => {
        const metadata = await stat(path);
        if (parsed.kind === "directory" && !metadata.isDirectory()) {
          throw new Error(`Selected attachment is not a directory: ${path}`);
        }
        if (parsed.kind !== "directory" && !metadata.isFile()) {
          throw new Error(`Selected attachment is not a file: ${path}`);
        }
        const mimeType = parsed.kind === "image" ? imageMimeType(path) : undefined;
        if (parsed.kind === "image" && metadata.size > MAX_IMAGE_ATTACHMENT_BYTES) {
          throw new Error(`Image attachments must be 20 MiB or smaller: ${basename(path)}`);
        }
        return {
          id: randomUUID(),
          kind: parsed.kind,
          name: basename(path),
          path,
          ...(mimeType === undefined ? {} : { mimeType }),
          ...(metadata.isFile() ? { size: metadata.size } : {}),
        };
      }),
    );
    return PickMissionAttachmentsResultSchema.parse({ attachments });
  });
  ipcMain.handle("missions:attachments:stage-clipboard-image", async (_event, input: unknown) => {
    const parsed = StageMissionClipboardImageSchema.parse(input);
    const data = Buffer.from(parsed.data, "base64");
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new Error("Pasted images must be 20 MiB or smaller.");
    }
    if (!matchesImageSignature(data, parsed.mimeType)) {
      throw new Error("Pasted image data does not match its image type.");
    }
    const extension = imageExtension(parsed.mimeType);
    const stagingRoot = join(options.temporaryRoot, "mission-clipboard-images");
    const path = join(stagingRoot, `${randomUUID()}${extension}`);
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await writeFile(path, data, { mode: 0o600 });
    stagedClipboardImages.add(path);
    return PickMissionAttachmentsResultSchema.parse({
      attachments: [
        {
          id: randomUUID(),
          kind: "image",
          name: parsed.name,
          path,
          mimeType: parsed.mimeType,
          size: data.byteLength,
        },
      ],
    });
  });
  ipcMain.handle("missions:create", async (_event, input: unknown) => {
    const parsed = CreateMissionSchema.parse(input);
    const mission = await options.creator
      .create({
        workspace: parsed.workspace,
        missionInput: parsed.input,
        ...(parsed.input.kind === "prompt" && parsed.input.attachments.length > 0
          ? { attachments: parsed.input.attachments }
          : {}),
        executorRef: parsed.executor.ref,
        ...(parsed.modelOverride === undefined ? {} : { modelOverride: parsed.modelOverride }),
        ...(parsed.toolPermissionMode === undefined
          ? {}
          : { toolPermissionMode: parsed.toolPermissionMode }),
      })
      .finally(async () => {
        if (parsed.input.kind === "prompt") {
          await cleanupStagedClipboardImages(parsed.input.attachments);
        }
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
      const mission = await options.runner
        .sendMessage(parsed)
        .finally(async () => await cleanupStagedClipboardImages(parsed.attachments));
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
  options.runner.subscribeChat((notification) => {
    forwardMissionChatNotification({
      notification,
      getSender: () => options.getWindow()?.webContents ?? null,
      refreshMissionSummary: async (missionId) => publishMission(await getUserMission(missionId)),
      reportSummaryRefreshFailure: (error, missionId) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            component: "desktop.missions",
            event: "mission_renderer_summary_refresh_failed",
            message: error instanceof Error ? error.message : String(error),
            missionId,
          }),
        );
      },
    });
  });
  options.runner.subscribeWork((notification) => {
    forwardMissionWorkNotification({
      notification,
      getSender: () => options.getWindow()?.webContents ?? null,
    });
  });
}

const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function attachmentDialogOptions(kind: "image" | "file" | "directory"): OpenDialogOptions {
  if (kind === "directory") {
    return { properties: ["openDirectory", "multiSelections"] };
  }
  return {
    properties: ["openFile", "multiSelections"],
    ...(kind === "image"
      ? {
          filters: [
            {
              name: "Images",
              extensions: ["png", "jpg", "jpeg", "gif", "webp"],
            },
          ],
        }
      : {}),
  };
}

function imageExtension(mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp") {
  switch (mimeType) {
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
  }
}

function matchesImageSignature(
  data: Buffer,
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp",
): boolean {
  switch (mimeType) {
    case "image/gif":
      return data.subarray(0, 4).toString("ascii") === "GIF8";
    case "image/jpeg":
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/png":
      return data
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return (
        data.subarray(0, 4).toString("ascii") === "RIFF" &&
        data.subarray(8, 12).toString("ascii") === "WEBP"
      );
  }
}

function imageMimeType(path: string): "image/gif" | "image/jpeg" | "image/png" | "image/webp" {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "gif":
      return "image/gif";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported image attachment type: ${basename(path)}`);
  }
}
