import { ipcRenderer, type IpcRendererEvent } from "electron";

import {
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionIdSchema,
} from "../../shared/contracts/mission-base.ts";
import {
  CreateMissionSchema,
  GetMissionChatSchema,
  GetMissionWorkConversationSchema,
  MissionActionSchema,
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  MissionContextCompactionResultSchema,
  MissionHumanInteractionSchema,
  MissionModelOptionsRequestSchema,
  MissionModelOptionsSchema,
  MissionSchema,
  MissionSummarySchema,
  MissionUpdateSchema,
  MissionWorkConversationSnapshotSchema,
  MissionWorkSnapshotSchema,
  MissionWorkUpdateSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  UpdateMissionOptionsSchema,
} from "../../shared/contracts/missions.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import { invokeMutation } from "../invoke-mutation.ts";
export const missionsApi = {
  listMissions: async () =>
    MissionSummarySchema.array().parse(await ipcRenderer.invoke("missions:list")),
  listMissionExecutors: async () =>
    MissionExecutorOptionSchema.array().parse(await ipcRenderer.invoke("missions:executors:list")),
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
  getMission: async (id) =>
    MissionSchema.parse(await ipcRenderer.invoke("missions:get", MissionIdSchema.parse(id))),
  subscribeMissionUpdates: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      listener(MissionUpdateSchema.parse(value));
    };
    ipcRenderer.on("missions:updated", handler);
    return () => ipcRenderer.removeListener("missions:updated", handler);
  },
  createMission: async (input) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:create", CreateMissionSchema.parse(input)),
    ),
  updateMissionOptions: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:options:update", UpdateMissionOptionsSchema.parse(input)),
    ),
  runMission: async (id) =>
    MissionSchema.parse(await invokeMutation("missions:run", MissionActionSchema.parse({ id }))),
  sendMissionMessage: async (input) =>
    MissionSchema.parse(
      await invokeMutation("missions:message:send", SendMissionMessageSchema.parse(input)),
    ),
  getMissionChat: async (input) =>
    MissionChatSnapshotSchema.parse(
      await ipcRenderer.invoke("missions:chat:get", GetMissionChatSchema.parse(input)),
    ),
  compactMissionContext: async (id) =>
    MissionContextCompactionResultSchema.parse(
      await invokeMutation("missions:context:compact", MissionActionSchema.parse({ id })),
    ),
  subscribeMissionChat: (id, listener) => {
    const missionId = MissionIdSchema.parse(id);
    const handler = (_event: IpcRendererEvent, value: unknown) => {
      const update = MissionChatUpdateSchema.parse(value);
      if (update.missionId === missionId) listener(update);
    };
    ipcRenderer.on("missions:chat:updated", handler);
    return () => ipcRenderer.removeListener("missions:chat:updated", handler);
  },
  interruptMission: async (id) =>
    MissionSchema.parse(
      await invokeMutation("missions:interrupt", MissionActionSchema.parse({ id })),
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
      await ipcRenderer.invoke("missions:complete", MissionActionSchema.parse({ id })),
    ),
  reopenMission: async (id) =>
    MissionSchema.parse(
      await ipcRenderer.invoke("missions:reopen", MissionActionSchema.parse({ id })),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "listMissions"
  | "listMissionExecutors"
  | "getMissionModelOptions"
  | "getMissionCreationDefaults"
  | "getMission"
  | "subscribeMissionUpdates"
  | "createMission"
  | "updateMissionOptions"
  | "runMission"
  | "sendMissionMessage"
  | "getMissionChat"
  | "compactMissionContext"
  | "subscribeMissionChat"
  | "interruptMission"
  | "getMissionWork"
  | "getMissionWorkConversation"
  | "subscribeMissionWork"
  | "deleteMission"
  | "listMissionHumanInteractions"
  | "respondToMissionHumanInteraction"
  | "markMissionComplete"
  | "reopenMission"
>;
