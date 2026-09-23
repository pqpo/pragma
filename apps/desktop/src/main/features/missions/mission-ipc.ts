import type { HomeProjectStore } from "./home-project-store.ts";
import {
  HomeProjectIdSchema,
  ReorderHomeProjectsSchema,
  SaveHomeProjectSchema,
} from "../../../shared/contracts/home-projects.ts";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type OpenDialogOptions,
  type WebContents,
} from "electron";
import type {
  LocalHostApplicationPort,
  LocalHostRunApplication,
  MissionControlApplication,
} from "@pragma/local-host";
import {
  createIntegrationError,
  IntegrationErrorSchema,
  MissionQueueSteerOutcomeSchema,
} from "@pragma/shared/integration";

import {
  CreateMissionSchema,
  CreateMissionBranchSchema,
  DiscardMissionAttachmentDraftsSchema,
  GetMissionChatPageSchema,
  GetMissionWorkConversationSchema,
  OpenMissionWorkConversationStreamSchema,
  CloseMissionWorkConversationStreamSchema,
  HomeExecutorPreferenceSchema,
  HomeMissionExecutorCatalogSchema,
  MissionActionSchema,
  MissionExecutionActionSchema,
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionModelOptionsRequestSchema,
  MissionMentionCandidatesSchema,
  MissionQueuePromptActionSchema,
  PickMissionAttachmentsResultSchema,
  PickMissionAttachmentsSchema,
  StageMissionClipboardImageSchema,
  MissionIdSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  UpdateMissionOptionsSchema,
  UpdateMissionContextMountsSchema,
  UpdateHomeExecutorPreferenceSchema,
  isUserFacingMissionOrigin,
  latestMissionBranchableReply,
  type Mission,
  type MissionSummary,
  type PickMissionAttachmentsResult,
  type DesktopToolPermissionMode,
} from "../../../shared/contracts/index.ts";
import { canonicalPragmaResourceRef, type PragmaExpertTeamResource } from "@pragma/interpreter/ast";
import type { MissionCommandOutcomeNotification, MissionRunner } from "./mission-runner.ts";
import { MissionStoreError, type MissionStore } from "./mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import {
  expertTeamCoordinatorMentionCandidate,
  expertTeamMentionCandidates,
  type MissionExecutorCatalog,
} from "./mission-executor-catalog.ts";
import type { MissionCreator } from "./mission-creator.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";
import { publishMissionUpdate } from "./mission-update-publisher.ts";
import { availableRecentWorkspaces } from "../workspaces/workspace-history-store.ts";
import type { HomeExecutorCatalog } from "./home-executor-catalog.ts";
import { installMissionAttachmentProtocol } from "./mission-attachment-protocol.ts";
import { createMissionImageDraftStore } from "./mission-image-drafts.ts";
import {
  forwardMissionChatNotification,
  forwardMissionStatusNotification,
  forwardMissionWorkNotification,
} from "./mission-renderer-update-forwarder.ts";
import { toLocalHostRunRequest } from "./local-host-mission-adapter.ts";
import { toMissionQueueCommand } from "./mission-queue-command.ts";

type DesktopLocalHostApplication = Pick<
  LocalHostApplicationPort<
    MissionSummary,
    Mission,
    Awaited<ReturnType<MissionExecutorCatalog["list"]>>[number],
    unknown,
    unknown
  >,
  "getMission" | "listMissions" | "listExecutors" | "resolveWorkspace"
> & {
  readonly missionControl: MissionControlApplication;
  readonly run: LocalHostRunApplication;
};

interface WorkConversationStreamOwner {
  readonly sender: WebContents;
  readonly onDestroyed: () => void;
}

export function installMissionHandlers(options: {
  readonly missions: MissionStore;
  readonly localHost: DesktopLocalHostApplication;
  readonly creator: MissionCreator;
  readonly executors: MissionExecutorCatalog;
  readonly homeProjects: HomeProjectStore;
  readonly homeExecutors: HomeExecutorCatalog;
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly runner: MissionRunner;
  readonly getAutomationMissionSources: () => Promise<ReadonlyMap<string, string>>;
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
  let legacyAutomationMissionSources: ReadonlyMap<string, string> = new Map();
  let legacyAutomationMissionSourcesRequest: Promise<ReadonlyMap<string, string>> | undefined;
  const imageDrafts = createMissionImageDraftStore({ temporaryRoot: options.temporaryRoot });
  const submittedAttachmentDrafts = new Map<string, readonly string[]>();
  const workConversationStreamOwners = new Map<string, WorkConversationStreamOwner>();
  const releaseWorkConversationStreamOwner = (
    subscriptionId: string,
    expected?: WorkConversationStreamOwner,
  ): boolean => {
    const owner = workConversationStreamOwners.get(subscriptionId);
    if (owner === undefined || (expected !== undefined && owner !== expected)) return false;
    workConversationStreamOwners.delete(subscriptionId);
    owner.sender.removeListener("destroyed", owner.onDestroyed);
    return true;
  };
  installMissionAttachmentProtocol(options.missions, imageDrafts);
  const getCreationDefaults = async () => {
    const workspace = await options.localHost.resolveWorkspace(await options.getDefaultWorkspace());
    const recentWorkspaces = await availableRecentWorkspaces(
      await options.getRecentWorkspaces(),
      workspace.identityHash,
      async (path) => await options.localHost.resolveWorkspace(path),
    );
    return MissionCreationDefaultsSchema.parse({
      workspace: { path: workspace.canonicalPath, basename: workspace.displayName },
      recentWorkspaces: recentWorkspaces.map((recent) => ({
        path: recent.canonicalPath,
        basename: recent.displayName,
      })),
      executorRef: options.defaultExecutorRef,
      toolPermissionMode: await options.getDefaultToolPermissionMode(),
    });
  };
  const ensureLegacyAutomationMissionSources = async (): Promise<void> => {
    legacyAutomationMissionSourcesRequest ??= options.getAutomationMissionSources();
    try {
      legacyAutomationMissionSources = await legacyAutomationMissionSourcesRequest;
    } catch (error) {
      legacyAutomationMissionSourcesRequest = undefined;
      throw error;
    }
  };
  const sourceForMission = async (mission: Mission): Promise<MissionSummary["source"]> => {
    const source = await options.missions.getListSource(mission);
    const automationRef =
      mission.origin.type === "user" ? legacyAutomationMissionSources.get(mission.id) : undefined;
    return automationRef === undefined ? source : { type: "automation", automationRef };
  };
  const publishMission = async (
    mission: Awaited<ReturnType<MissionStore["get"]>>,
  ): Promise<void> => {
    if (!isUserFacingMissionOrigin(mission.origin)) return;
    publishMissionUpdate(() => options.getWindow()?.webContents ?? null, {
      kind: "upsert",
      mission,
      source: await sourceForMission(mission),
    });
  };
  const publishRemoval = (missionId: string): void => {
    publishMissionUpdate(() => options.getWindow()?.webContents ?? null, {
      kind: "remove",
      missionId,
    });
  };
  const getManagedMission = async (id: string) => {
    await ensureLegacyAutomationMissionSources();
    const mission = await options.localHost.getMission(id);
    if (!isUserFacingMissionOrigin(mission.origin)) {
      throw new MissionStoreError("mission_not_found", "Mission was not found.");
    }
    return mission;
  };
  const assertManagedMission = async (id: string): Promise<string> => {
    await getManagedMission(id);
    return id;
  };
  const waitForLocalHostCommand = async (input: {
    readonly missionId: string;
    readonly requestId: string;
  }) => {
    const operation = await options.localHost.missionControl.waitForTerminal(input);
    if (operation.state === "applied") return operation;
    if (operation.error !== undefined) throw operation.error;
    throw createIntegrationError({
      code: "COMMAND_REJECTED",
      category: "conflict",
      message: `Mission command ${input.requestId} did not apply.`,
      details: { missionId: input.missionId, requestId: input.requestId },
    });
  };
  const runLocalHostCommand = async (input: Parameters<MissionControlApplication["submit"]>[0]) => {
    await options.localHost.missionControl.submit(input);
    return await waitForLocalHostCommand({
      missionId: input.missionId,
      requestId: input.requestId,
    });
  };
  const forwardCommandOutcome = (outcome: MissionCommandOutcomeNotification): void => {
    try {
      options.getWindow()?.webContents.send("missions:command:outcome", {
        schemaVersion: "pragma.desktop-mission-command-outcome/v1",
        ...outcome,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          component: "desktop.missions",
          event: "mission_command_outcome_delivery_failed",
          message: error instanceof Error ? error.message : String(error),
          missionId: outcome.missionId,
          requestId: outcome.requestId,
        }),
      );
    }
    const attachmentIds = submittedAttachmentDrafts.get(outcome.requestId) ?? [];
    submittedAttachmentDrafts.delete(outcome.requestId);
    void Promise.resolve()
      .then(async () => {
        if (outcome.state === "applied" && attachmentIds.length > 0) {
          await imageDrafts.discard(attachmentIds);
        }
        await publishMission(await getManagedMission(outcome.missionId));
      })
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            level: "warn",
            component: "desktop.missions",
            event: "mission_command_outcome_projection_failed",
            message: error instanceof Error ? error.message : String(error),
            missionId: outcome.missionId,
            requestId: outcome.requestId,
          }),
        );
      });
  };
  options.runner.subscribeCommandOutcomes(forwardCommandOutcome);
  ipcMain.handle("missions:list", async () => {
    await ensureLegacyAutomationMissionSources();
    return (await options.localHost.listMissions()).map((mission) => {
      if (mission.source.type === "automation") return mission;
      const automationRef = legacyAutomationMissionSources.get(mission.id);
      return automationRef === undefined
        ? mission
        : { ...mission, source: { type: "automation" as const, automationRef } };
    });
  });
  ipcMain.handle("missions:source:get", (_event, id: unknown) =>
    runDesktopMutation(async () =>
      sourceForMission(await getManagedMission(MissionIdSchema.parse(id))),
    ),
  );
  ipcMain.handle("missions:get", (_event, id: unknown) =>
    runDesktopMutation(async () => await getManagedMission(MissionIdSchema.parse(id))),
  );
  ipcMain.handle("missions:mentions:get", async (_event, id: unknown) => {
    const mission = await getManagedMission(MissionIdSchema.parse(id));
    if (mission.executor.kind !== "team") {
      throw new MissionStoreError("config_invalid", "Only ExpertTeam Missions have mentions.");
    }
    const project = await options.project.getRevision(mission.project.revision);
    const team = project.resources.find(
      (resource): resource is PragmaExpertTeamResource =>
        resource.kind === "ExpertTeam" &&
        canonicalPragmaResourceRef(resource) === mission.executor.ref,
    );
    if (team === undefined) {
      throw new MissionStoreError("config_invalid", "Mission ExpertTeam was not found.");
    }
    return MissionMentionCandidatesSchema.parse({
      teamRef: mission.executor.ref,
      coordinator: expertTeamCoordinatorMentionCandidate(team, project.resources, (ref) =>
        options.systemExperts.getResource(ref),
      ),
      members: expertTeamMentionCandidates(team, project.resources, (ref) =>
        options.systemExperts.getResource(ref),
      ),
    });
  });
  ipcMain.handle("missions:executors:list", async () =>
    MissionExecutorOptionSchema.array().parse(await options.localHost.listExecutors()),
  );
  ipcMain.handle("missions:home-projects:list", () => options.homeProjects.list());
  ipcMain.handle("missions:home-projects:save", (_event, input: unknown) =>
    runDesktopMutation(() => options.homeProjects.save(SaveHomeProjectSchema.parse(input))),
  );
  ipcMain.handle("missions:home-projects:reorder", (_event, ids: unknown) =>
    runDesktopMutation(() => options.homeProjects.reorder(ReorderHomeProjectsSchema.parse(ids))),
  );
  ipcMain.handle("missions:home-projects:delete", (_event, id: unknown) =>
    runDesktopMutation(() => options.homeProjects.delete(HomeProjectIdSchema.parse(id))),
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
    const mission = await getManagedMission(missionId);
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
    const results: PickMissionAttachmentsResult[] = [];
    try {
      for (const path of result.filePaths) {
        if (parsed.kind === "image") {
          results.push(await imageDrafts.stagePath(path));
          continue;
        }
        const metadata = await stat(path);
        if (parsed.kind === "directory" && !metadata.isDirectory()) {
          throw new Error(`Selected attachment is not a directory: ${path}`);
        }
        if (parsed.kind !== "directory" && !metadata.isFile()) {
          throw new Error(`Selected attachment is not a file: ${path}`);
        }
        results.push({
          attachments: [
            {
              id: randomUUID(),
              kind: parsed.kind,
              name: basename(path),
              path,
              ...(metadata.isFile() ? { size: metadata.size } : {}),
            },
          ],
          previews: [],
        });
      }
    } catch (error) {
      await imageDrafts.discard(
        results.flatMap((entry) => entry.attachments.map((attachment) => attachment.id)),
      );
      throw error;
    }
    return PickMissionAttachmentsResultSchema.parse({
      attachments: results.flatMap((entry) => entry.attachments),
      previews: results.flatMap((entry) => entry.previews),
    });
  });
  ipcMain.handle("missions:attachments:stage-clipboard-image", async (_event, input: unknown) => {
    const parsed = StageMissionClipboardImageSchema.parse(input);
    return PickMissionAttachmentsResultSchema.parse(await imageDrafts.stageClipboard(parsed));
  });
  ipcMain.handle("missions:attachments:discard-drafts", async (_event, input: unknown) => {
    const parsed = DiscardMissionAttachmentDraftsSchema.parse(input);
    await imageDrafts.discard(parsed.attachmentIds);
  });
  ipcMain.handle("missions:create", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = CreateMissionSchema.parse(input);
      const mission = await options.creator.create({
        workspace: parsed.workspace,
        missionInput: parsed.input,
        ...(parsed.input.kind === "prompt" && parsed.input.attachments.length > 0
          ? { attachments: parsed.input.attachments }
          : {}),
        executorRef: parsed.executor.ref,
        contextMounts: parsed.contextMounts,
        ...(parsed.modelOverride === undefined ? {} : { modelOverride: parsed.modelOverride }),
        ...(parsed.toolPermissionMode === undefined
          ? {}
          : { toolPermissionMode: parsed.toolPermissionMode }),
      });
      if (parsed.input.kind === "prompt") {
        await imageDrafts.discard(parsed.input.attachments.map((attachment) => attachment.id));
      }
      await Promise.all([
        options.recordWorkspaceUsage(parsed.workspace),
        options.homeExecutors.recordUsage(parsed.executor.ref, parsed.workspace),
      ]);
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:branch:create", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = CreateMissionBranchSchema.parse(input);
      const source = await getManagedMission(parsed.sourceMissionId);
      if (source.executor.kind === "flow") {
        throw new Error("Flow missions cannot create conversation branches.");
      }
      const [newest, state] = await Promise.all([
        options.runner.getChatPage({ id: source.id, limit: 50 }),
        options.runner.getConversationState(source.id),
      ]);
      if (
        (state.execution?.id ?? null) !== parsed.expectedExecutionId ||
        (state.execution !== undefined &&
          !["succeeded", "failed", "cancelled"].includes(state.execution.status)) ||
        (state.queue?.state ?? "idle") !== "idle" ||
        (state.queue?.pendingCount ?? 0) !== 0 ||
        state.pendingInteractions.length !== 0
      ) {
        throw new Error("Wait for the source Mission to become idle before creating a branch.");
      }
      if (newest.syncIssues !== undefined && newest.syncIssues.length > 0) {
        throw new Error("Mission history is temporarily incomplete. Refresh it before branching.");
      }
      const pages = [newest];
      let beforeCursor = newest.page.nextBeforeCursor;
      while (beforeCursor !== undefined) {
        const page = await options.runner.getChatPage({
          id: source.id,
          beforeCursor,
          limit: 50,
        });
        if (page.syncIssues !== undefined && page.syncIssues.length > 0) {
          throw new Error(
            "Mission history is temporarily incomplete. Refresh it before branching.",
          );
        }
        pages.unshift(page);
        beforeCursor = page.page.nextBeforeCursor;
      }
      const history = pages
        .flatMap((page) => page.entries)
        .filter(
          (entry) =>
            entry.kind !== "user" ||
            (entry.delivery?.removed !== true && entry.delivery?.status !== "queued"),
        );
      const latestReply = latestMissionBranchableReply(history);
      if (latestReply?.id !== parsed.expectedMessageId) {
        throw new Error("The selected reply is no longer the latest completed Mission reply.");
      }
      const cutoffIndex = history.findIndex((entry) => entry.id === latestReply.id);
      if (cutoffIndex < 0) {
        throw new Error("The selected reply is missing from the Mission history.");
      }
      const mission = await options.creator.createBranch({
        source,
        expectedExecutionId: parsed.expectedExecutionId,
        expectedMessageId: parsed.expectedMessageId,
        history: history.slice(0, cutoffIndex + 1),
      });
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:run", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const missionId = await assertManagedMission(MissionActionSchema.parse(input).id);
      const mission = await options.localHost.getMission(missionId);
      if (mission.branch !== undefined && mission.execution === undefined) {
        throw new Error("Continue a branched Mission by sending a new message.");
      }
      if (
        mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status)
      ) {
        const recovered = await options.runner.recover(missionId, mission.execution.id);
        await publishMission(recovered);
        return recovered;
      }
      const executor = (await options.localHost.listExecutors()).find(
        (candidate) => candidate.ref === mission.executor.ref,
      );
      if (executor === undefined) {
        throw new Error(`Mission executor is unavailable: ${mission.executor.ref}.`);
      }
      const workspace = await options.localHost.resolveWorkspace(mission.workspace.path);
      const request = toLocalHostRunRequest({
        mission,
        workspace,
        executorSource: executor.origin === "project" ? "project" : "built_in",
      });
      const handle = await options.localHost.run.startAttached(
        {
          missionId,
          request,
        },
        {
          // Desktop answers human interactions asynchronously through the Mission
          // command inbox. Keep the originating Runtime/tool call alive so the
          // answer completes that exact call instead of racing a checkpoint cancel.
          onHumanInteraction: async () => ({ kind: "await_external_response" }),
        },
      );
      await handle.outcome;
      const refreshed = await getManagedMission(missionId);
      await publishMission(refreshed);
      return refreshed;
    }),
  );
  ipcMain.handle("missions:recover", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = MissionExecutionActionSchema.parse(input);
      const missionId = await assertManagedMission(parsed.id);
      const recovered = await options.runner.recover(missionId, parsed.expectedExecutionId);
      await publishMission(recovered);
      return recovered;
    }),
  );
  ipcMain.handle("missions:options:update", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = UpdateMissionOptionsSchema.parse(input);
      await assertManagedMission(parsed.id);
      const mission = await options.runner.updateOptions(parsed);
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:context-mounts:update", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = UpdateMissionContextMountsSchema.parse(input);
      await assertManagedMission(parsed.id);
      const mission = await options.runner.updateContextMounts(parsed);
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:message:send", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = SendMissionMessageSchema.parse(input);
      await assertManagedMission(parsed.id);
      const kind = parsed.mode === "steer" ? ("steer" as const) : ("send" as const);
      submittedAttachmentDrafts.set(
        parsed.requestId,
        parsed.attachments.map((attachment) => attachment.id),
      );
      let submission: Awaited<ReturnType<MissionControlApplication["submit"]>>;
      try {
        submission = await options.localHost.missionControl.submit({
          missionId: parsed.id,
          requestId: parsed.requestId,
          kind,
          payload: {
            kind,
            input: { prompt: parsed.content, attachments: parsed.attachments },
          },
        });
      } catch (error) {
        submittedAttachmentDrafts.delete(parsed.requestId);
        throw error;
      }
      if (submission.operation.state === "applied") {
        forwardCommandOutcome({
          missionId: parsed.id,
          requestId: parsed.requestId,
          state: "applied",
          ...(submission.operation.result === undefined
            ? {}
            : { result: submission.operation.result }),
        });
      } else if (
        submission.operation.state === "rejected" ||
        submission.operation.state === "expired" ||
        submission.operation.state === "failed"
      ) {
        const parsedError = IntegrationErrorSchema.safeParse(submission.operation.error);
        forwardCommandOutcome({
          missionId: parsed.id,
          requestId: parsed.requestId,
          state: "rejected",
          ...(parsedError.success ? { error: parsedError.data } : {}),
        });
      }
      return {
        schemaVersion: "pragma.desktop-mission-command-receipt/v1" as const,
        missionId: parsed.id,
        requestId: parsed.requestId,
        kind,
        state: submission.operation.state,
        createdAt: submission.operation.createdAt,
        updatedAt: submission.operation.updatedAt,
        requestedMode: parsed.mode,
      };
    }),
  );
  ipcMain.handle("missions:queue:try-steer", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = MissionQueuePromptActionSchema.parse(input);
      await assertManagedMission(parsed.id);
      const operation = await runLocalHostCommand(toMissionQueueCommand(parsed, "queue.try-steer"));
      const mission = await getManagedMission(parsed.id);
      await publishMission(mission);
      return {
        mission,
        queueSteer: MissionQueueSteerOutcomeSchema.parse(operation.result?.["queueSteer"]),
      };
    }),
  );
  ipcMain.handle("missions:queue:remove", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = MissionQueuePromptActionSchema.parse(input);
      await assertManagedMission(parsed.id);
      await runLocalHostCommand(toMissionQueueCommand(parsed, "queue.remove"));
      const mission = await getManagedMission(parsed.id);
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:chat:page:get", async (_event, input: unknown) => {
    return await options.runner.getChatPage(GetMissionChatPageSchema.parse(input));
  });
  ipcMain.handle("missions:conversation-state:get", async (_event, input: unknown) => {
    const parsed = MissionActionSchema.parse(input);
    return await options.runner.getConversationState(parsed.id);
  });
  ipcMain.handle("missions:context-window:get", async (_event, input: unknown) => {
    const parsed = MissionActionSchema.parse(input);
    return await options.runner.getContextWindow(parsed.id);
  });
  ipcMain.handle("missions:context:compact", (_event, input: unknown) =>
    runDesktopMutation(
      async () =>
        await options.runner.compactContext(
          await assertManagedMission(MissionActionSchema.parse(input).id),
        ),
    ),
  );
  ipcMain.handle("missions:interrupt", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = MissionExecutionActionSchema.parse(input);
      const missionId = await assertManagedMission(parsed.id);
      await runLocalHostCommand({
        missionId,
        requestId: parsed.requestId,
        kind: "interrupt",
        target: { executionId: parsed.expectedExecutionId },
        payload: { kind: "interrupt" },
      });
      const mission = await getManagedMission(missionId);
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:interrupt:force", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = MissionExecutionActionSchema.parse(input);
      const missionId = await assertManagedMission(parsed.id);
      const interrupted = await options.runner.forceInterrupt(
        missionId,
        parsed.expectedExecutionId,
      );
      await publishMission(interrupted);
      return interrupted;
    }),
  );
  ipcMain.handle("missions:queue:resume", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const missionId = await assertManagedMission(MissionActionSchema.parse(input).id);
      const requestId = randomUUID();
      await runLocalHostCommand({
        missionId,
        requestId,
        kind: "queue.resume",
        payload: { kind: "queue.resume" },
      });
      const mission = await getManagedMission(missionId);
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle(
    "missions:work:get",
    async (_event, input: unknown) =>
      await options.runner.getWork(await assertManagedMission(MissionActionSchema.parse(input).id)),
  );
  ipcMain.handle("missions:work:conversation:get", async (_event, input: unknown) => {
    const parsed = GetMissionWorkConversationSchema.parse(input);
    await assertManagedMission(parsed.id);
    return await options.runner.getWorkConversation(parsed);
  });
  ipcMain.handle("missions:work:conversation:stream:open", async (event, input: unknown) => {
    const parsed = OpenMissionWorkConversationStreamSchema.parse(input);
    await assertManagedMission(parsed.missionId);
    releaseWorkConversationStreamOwner(parsed.subscriptionId);
    const owner: WorkConversationStreamOwner = {
      sender: event.sender,
      onDestroyed: () => {
        if (!releaseWorkConversationStreamOwner(parsed.subscriptionId, owner)) return;
        void options.runner.closeWorkConversationStream(parsed.subscriptionId);
      },
    };
    workConversationStreamOwners.set(parsed.subscriptionId, owner);
    event.sender.once("destroyed", owner.onDestroyed);
    try {
      const opened = await options.runner.openWorkConversationStream(parsed);
      if (workConversationStreamOwners.get(parsed.subscriptionId) !== owner) {
        await options.runner.closeWorkConversationStream(parsed.subscriptionId);
      }
      return opened;
    } catch (error) {
      releaseWorkConversationStreamOwner(parsed.subscriptionId, owner);
      throw error;
    }
  });
  ipcMain.handle("missions:work:conversation:stream:close", async (event, input: unknown) => {
    const parsed = CloseMissionWorkConversationStreamSchema.parse(input);
    const owner = workConversationStreamOwners.get(parsed.subscriptionId);
    if (owner?.sender === event.sender) {
      releaseWorkConversationStreamOwner(parsed.subscriptionId, owner);
      await options.runner.closeWorkConversationStream(parsed.subscriptionId);
    }
  });
  ipcMain.handle(
    "missions:human:list",
    async (_event, input: unknown) =>
      await options.runner.listHumanInteractions(
        await assertManagedMission(MissionActionSchema.parse(input).id),
      ),
  );
  ipcMain.handle("missions:human:respond", async (_event, input: unknown) => {
    return await runDesktopMutation(async () => {
      const parsed = RespondMissionHumanInteractionSchema.parse(input);
      await assertManagedMission(parsed.missionId);
      await runLocalHostCommand({
        missionId: parsed.missionId,
        requestId: parsed.requestId,
        kind: "respond",
        payload: { kind: "respond", response: parsed.response },
        target: { interactionId: parsed.interactionId },
      });
    });
  });
  ipcMain.handle("missions:complete", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const missionId = await assertManagedMission(MissionActionSchema.parse(input).id);
      const mission = await options.missions.markComplete(missionId);
      if (
        isUserFacingMissionOrigin(mission.origin) &&
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
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:reopen", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const missionId = await assertManagedMission(MissionActionSchema.parse(input).id);
      const mission = await options.missions.reopen(missionId);
      if (isUserFacingMissionOrigin(mission.origin)) {
        await options.onMissionLifecycleChange?.({ missionId: mission.id, state: "active" });
      }
      await publishMission(mission);
      return mission;
    }),
  );
  ipcMain.handle("missions:delete", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const missionId = MissionActionSchema.parse(input).id;
      await assertManagedMission(missionId);
      const mission = await getManagedMission(missionId);
      if (
        mission.execution !== undefined &&
        ["queued", "running", "waiting"].includes(mission.execution.status)
      ) {
        try {
          await options.runner.forceInterrupt(missionId, mission.execution.id);
        } catch (error) {
          const refreshed = await getManagedMission(missionId);
          if (
            refreshed.execution !== undefined &&
            ["queued", "running", "waiting"].includes(refreshed.execution.status)
          ) {
            throw error;
          }
        }
      }
      await options.runner.delete(missionId);
      publishRemoval(missionId);
    }),
  );
  options.runner.subscribeChat((notification) => {
    forwardMissionChatNotification({
      notification,
      getSender: () => options.getWindow()?.webContents ?? null,
    });
  });
  options.runner.subscribeStatus((notification) => {
    forwardMissionStatusNotification({
      notification,
      getSender: () => options.getWindow()?.webContents ?? null,
    });
  });
  options.runner.subscribeWork((notification) => {
    forwardMissionWorkNotification({
      notification,
      getSender: () => options.getWindow()?.webContents ?? null,
    });
  });
  options.runner.subscribeWorkConversationStreams(({ update }) => {
    const owner = workConversationStreamOwners.get(update.subscriptionId);
    const target = options.getWindow()?.webContents;
    if (target === undefined || owner?.sender !== target) return;
    target.send("missions:work:conversation:stream:updated", update);
  });
}

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
