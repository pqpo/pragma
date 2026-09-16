import {
  HomeProjectSchema,
  SaveHomeProjectSchema,
  HomeProjectIdSchema,
  ReorderHomeProjectsSchema,
} from "../../shared/contracts/home-projects.ts";
import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  HomeExecutorPreferenceSchema,
  HomeMissionExecutorCatalogSchema,
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionIdSchema,
  MissionMentionCandidatesSchema,
  UpdateHomeExecutorPreferenceSchema,
} from "../../shared/contracts/mission-base.ts";
import {
  CreateMissionSchema,
  CreateMissionBranchSchema,
  DiscardMissionAttachmentDraftsSchema,
  GetMissionChatSchema,
  GetMissionWorkConversationSchema,
  MissionActionSchema,
  MissionExecutionActionSchema,
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  MissionContextCompactionResultSchema,
  MissionHumanInteractionSchema,
  MissionModelOptionsRequestSchema,
  MissionModelOptionsSchema,
  MissionCommandReceiptSchema,
  MissionCommandOutcomeSchema,
  MissionQueuePromptActionSchema,
  MissionQueueSteerResultSchema,
  MissionSchema,
  MissionSummarySchema,
  MissionStatusUpdateSchema,
  MissionUpdateSchema,
  MissionWorkConversationSnapshotSchema,
  MissionWorkSnapshotSchema,
  MissionWorkUpdateSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  UpdateMissionOptionsSchema,
  UpdateMissionContextMountsSchema,
  PickMissionAttachmentsResultSchema,
  PickMissionAttachmentsSchema,
  StageMissionClipboardImageSchema,
} from "../../shared/contracts/missions.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  GetMissionContextStoreSchema,
  ListMissionContextStoreEntriesSchema,
  MissionContextStoreContentSchema,
  MissionContextStoreDescriptorSchema,
  MissionContextStoreEntrySchema,
  MissionContextStoreSearchMatchSchema,
  ReadMissionContextStoreEntrySchema,
  SearchMissionContextStoreSchema,
} from "../../shared/contracts/context-store-browser.ts";
import { invokeMutation } from "../invoke-mutation.ts";
export const missionsApi = {
  listHomeProjects: async () =>
    HomeProjectSchema.array().parse(await ipcRenderer.invoke("missions:home-projects:list")),
  saveHomeProject: async (input) =>
    HomeProjectSchema.parse(
      await invokeMutation("missions:home-projects:save", SaveHomeProjectSchema.parse(input)),
    ),
  reorderHomeProjects: async (projectIds) =>
    HomeProjectSchema.array().parse(
      await invokeMutation(
        "missions:home-projects:reorder",
        ReorderHomeProjectsSchema.parse(projectIds),
      ),
    ),
  deleteHomeProject: async (id) => {
    await invokeMutation("missions:home-projects:delete", HomeProjectIdSchema.parse(id));
  },
  listMissions: async () =>
    MissionSummarySchema.array().parse(await ipcRenderer.invoke("missions:list")),
  listMissionExecutors: async () =>
    MissionExecutorOptionSchema.array().parse(await ipcRenderer.invoke("missions:executors:list")),
  getHomeMissionExecutorCatalog: async () =>
    HomeMissionExecutorCatalogSchema.parse(await ipcRenderer.invoke("missions:home-executors:get")),
  updateHomeExecutorPreference: async (input) =>
    HomeExecutorPreferenceSchema.parse(
      await invokeMutation(
        "missions:home-executor-preference:update",
        UpdateHomeExecutorPreferenceSchema.parse(input),
      ),
    ),
  getMissionModelOptions: async (executorRef, missionId) =>
    MissionModelOptionsSchema.parse(
      await ipcRenderer.invoke(
        "missions:model-options:get",
        MissionModelOptionsRequestSchema.parse({
          executorRef,
          ...(missionId === undefined ? {} : { missionId }),
        }),
      ),
    ),
  getMissionCreationDefaults: async () =>
    MissionCreationDefaultsSchema.parse(await ipcRenderer.invoke("missions:create-defaults:get")),
  getMissionListSource: async (id) =>
    MissionSummarySchema.shape.source.parse(
      await invokeMutation("missions:source:get", MissionIdSchema.parse(id)),
    ),
  getMission: async (id) =>
    MissionSchema.parse(await invokeMutation("missions:get", MissionIdSchema.parse(id))),
  getMissionMentionCandidates: async (id) =>
    MissionMentionCandidatesSchema.parse(
      await ipcRenderer.invoke("missions:mentions:get", MissionIdSchema.parse(id)),
    ),
  getMissionContextStore: async (input) =>
    MissionContextStoreDescriptorSchema.parse(
      await ipcRenderer.invoke(
        "mission-context-stores:get",
        GetMissionContextStoreSchema.parse(input),
      ),
    ),
  listMissionContextStoreEntries: async (input) =>
    MissionContextStoreEntrySchema.array().parse(
      await ipcRenderer.invoke(
        "mission-context-stores:list",
        ListMissionContextStoreEntriesSchema.parse(input),
      ),
    ),
  readMissionContextStoreEntry: async (input) =>
    MissionContextStoreContentSchema.parse(
      await ipcRenderer.invoke(
        "mission-context-stores:read",
        ReadMissionContextStoreEntrySchema.parse(input),
      ),
    ),
  searchMissionContextStore: async (input) =>
    MissionContextStoreSearchMatchSchema.array().parse(
      await ipcRenderer.invoke(
        "mission-context-stores:search",
        SearchMissionContextStoreSchema.parse(input),
      ),
    ),
  subscribeMissionUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(MissionUpdateSchema.parse(value));
    };
    ipcRenderer.on("missions:updated", handler);
    return () => ipcRenderer.removeListener("missions:updated", handler);
  },
  subscribeMissionStatusUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(MissionStatusUpdateSchema.parse(value));
    };
    ipcRenderer.on("missions:status:updated", handler);
    return () => ipcRenderer.removeListener("missions:status:updated", handler);
  },
  subscribeMissionCommandOutcomes: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(MissionCommandOutcomeSchema.parse(value));
    };
    ipcRenderer.on("missions:command:outcome", handler);
    return () => ipcRenderer.removeListener("missions:command:outcome", handler);
  },
  createMission: async (input) =>
    MissionSchema.parse(await invokeMutation("missions:create", CreateMissionSchema.parse(input))),
  createMissionBranch: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:branch:create", CreateMissionBranchSchema.parse(input)),
    ),
  pickMissionAttachments: async (input) =>
    PickMissionAttachmentsResultSchema.parse(
      await ipcRenderer.invoke(
        "missions:attachments:pick",
        PickMissionAttachmentsSchema.parse(input),
      ),
    ),
  stageMissionClipboardImage: async (input) =>
    PickMissionAttachmentsResultSchema.parse(
      await ipcRenderer.invoke(
        "missions:attachments:stage-clipboard-image",
        StageMissionClipboardImageSchema.parse(input),
      ),
    ),
  discardMissionAttachmentDrafts: async (input) => {
    await ipcRenderer.invoke(
      "missions:attachments:discard-drafts",
      DiscardMissionAttachmentDraftsSchema.parse(input),
    );
  },
  updateMissionOptions: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:options:update", UpdateMissionOptionsSchema.parse(input)),
    ),
  updateMissionContextMounts: async (input) =>
    MissionSchema.parse(
      await invokeMutation(
        "missions:context-mounts:update",
        UpdateMissionContextMountsSchema.parse(input),
      ),
    ),
  runMission: async (id) =>
    MissionSchema.parse(await invokeMutation("missions:run", MissionActionSchema.parse({ id }))),
  recoverMission: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:recover", MissionExecutionActionSchema.parse(input)),
    ),
  sendMissionMessage: async (input) =>
    MissionCommandReceiptSchema.parse(
      await invokeMutation("missions:message:send", SendMissionMessageSchema.parse(input)),
    ),
  trySteerQueuedMissionMessage: async (input) =>
    MissionQueueSteerResultSchema.parse(
      await invokeMutation("missions:queue:try-steer", MissionQueuePromptActionSchema.parse(input)),
    ),
  removeQueuedMissionMessage: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:queue:remove", MissionQueuePromptActionSchema.parse(input)),
    ),
  getMissionChat: async (input) =>
    MissionChatSnapshotSchema.parse(
      await ipcRenderer.invoke("missions:chat:get", GetMissionChatSchema.parse(input)),
    ),
  compactMissionContext: async (id) =>
    MissionContextCompactionResultSchema.parse(
      await invokeMutation("missions:context:compact", MissionActionSchema.parse({ id })),
    ),
  subscribeMissionChatUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(MissionChatUpdateSchema.parse(value));
    };
    ipcRenderer.on("missions:chat:updated", handler);
    return () => ipcRenderer.removeListener("missions:chat:updated", handler);
  },
  subscribeMissionChat: (id, listener) => {
    const missionId = MissionIdSchema.parse(id);
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      const update = MissionChatUpdateSchema.parse(value);
      if (update.missionId === missionId) listener(update);
    };
    ipcRenderer.on("missions:chat:updated", handler);
    return () => ipcRenderer.removeListener("missions:chat:updated", handler);
  },
  interruptMission: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:interrupt", MissionExecutionActionSchema.parse(input)),
    ),
  forceInterruptMission: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:interrupt:force", MissionExecutionActionSchema.parse(input)),
    ),
  resumeMissionQueue: async (id) =>
    MissionSchema.parse(
      await invokeMutation("missions:queue:resume", MissionActionSchema.parse({ id })),
    ),
  getMissionWork: async (id) =>
    MissionWorkSnapshotSchema.parse(
      await ipcRenderer.invoke("missions:work:get", MissionActionSchema.parse({ id })),
    ),
  getMissionWorkConversation: async (input) =>
    MissionWorkConversationSnapshotSchema.parse(
      await ipcRenderer.invoke(
        "missions:work:conversation:get",
        GetMissionWorkConversationSchema.parse(input),
      ),
    ),
  subscribeMissionWork: (id, listener) => {
    const missionId = MissionIdSchema.parse(id);
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      const update = MissionWorkUpdateSchema.parse(value);
      if (update.missionId === missionId) listener(update);
    };
    ipcRenderer.on("missions:work:updated", handler);
    return () => ipcRenderer.removeListener("missions:work:updated", handler);
  },
  deleteMission: async (id) => {
    await invokeMutation("missions:delete", MissionActionSchema.parse({ id }));
  },
  listMissionHumanInteractions: async (id) =>
    MissionHumanInteractionSchema.array().parse(
      await ipcRenderer.invoke("missions:human:list", MissionActionSchema.parse({ id })),
    ),
  respondToMissionHumanInteraction: async (input) => {
    await invokeMutation(
      "missions:human:respond",
      RespondMissionHumanInteractionSchema.parse(input),
    );
  },
  markMissionComplete: async (id) =>
    MissionSchema.parse(
      await invokeMutation("missions:complete", MissionActionSchema.parse({ id })),
    ),
  reopenMission: async (id) =>
    MissionSchema.parse(await invokeMutation("missions:reopen", MissionActionSchema.parse({ id }))),
} satisfies Pick<
  PragmaDesktopAPI,
  | "listMissions"
  | "listMissionExecutors"
  | "getHomeMissionExecutorCatalog"
  | "updateHomeExecutorPreference"
  | "listHomeProjects"
  | "saveHomeProject"
  | "reorderHomeProjects"
  | "deleteHomeProject"
  | "getMissionModelOptions"
  | "getMissionCreationDefaults"
  | "getMissionListSource"
  | "getMission"
  | "getMissionMentionCandidates"
  | "getMissionContextStore"
  | "listMissionContextStoreEntries"
  | "readMissionContextStoreEntry"
  | "searchMissionContextStore"
  | "subscribeMissionUpdates"
  | "subscribeMissionStatusUpdates"
  | "subscribeMissionCommandOutcomes"
  | "createMission"
  | "createMissionBranch"
  | "pickMissionAttachments"
  | "stageMissionClipboardImage"
  | "discardMissionAttachmentDrafts"
  | "updateMissionOptions"
  | "updateMissionContextMounts"
  | "runMission"
  | "recoverMission"
  | "sendMissionMessage"
  | "trySteerQueuedMissionMessage"
  | "removeQueuedMissionMessage"
  | "getMissionChat"
  | "compactMissionContext"
  | "subscribeMissionChatUpdates"
  | "subscribeMissionChat"
  | "interruptMission"
  | "forceInterruptMission"
  | "resumeMissionQueue"
  | "getMissionWork"
  | "getMissionWorkConversation"
  | "subscribeMissionWork"
  | "deleteMission"
  | "listMissionHumanInteractions"
  | "respondToMissionHumanInteraction"
  | "markMissionComplete"
  | "reopenMission"
>;
