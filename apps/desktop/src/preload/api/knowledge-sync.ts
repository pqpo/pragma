import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  KnowledgeSyncOverviewSchema,
  ResolveKnowledgeSyncConflictSchema,
  RestoreIgnoredRemoteKnowledgeBaseSchema,
  UpdateKnowledgeSyncConfigurationSchema,
} from "../../shared/contracts/index.ts";
import { invokeMutation } from "../invoke-mutation.ts";

export const knowledgeSyncApi = {
  getKnowledgeSyncOverview: async () =>
    KnowledgeSyncOverviewSchema.parse(await ipcRenderer.invoke("knowledge-sync:get")),
  updateKnowledgeSyncConfiguration: async (input) =>
    KnowledgeSyncOverviewSchema.parse(
      await invokeMutation(
        "knowledge-sync:configure",
        UpdateKnowledgeSyncConfigurationSchema.parse(input),
      ),
    ),
  removeKnowledgeSyncConfiguration: async () => {
    await invokeMutation("knowledge-sync:remove");
  },
  syncKnowledgeBases: async () =>
    KnowledgeSyncOverviewSchema.parse(await invokeMutation("knowledge-sync:run")),
  refreshKnowledgeBases: async () =>
    KnowledgeSyncOverviewSchema.parse(await invokeMutation("knowledge-sync:refresh")),
  resolveKnowledgeSyncConflict: async (input) =>
    KnowledgeSyncOverviewSchema.parse(
      await invokeMutation(
        "knowledge-sync:resolve",
        ResolveKnowledgeSyncConflictSchema.parse(input),
      ),
    ),
  restoreIgnoredRemoteKnowledgeBase: async (input) =>
    KnowledgeSyncOverviewSchema.parse(
      await invokeMutation(
        "knowledge-sync:restore",
        RestoreIgnoredRemoteKnowledgeBaseSchema.parse(input),
      ),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "getKnowledgeSyncOverview"
  | "updateKnowledgeSyncConfiguration"
  | "removeKnowledgeSyncConfiguration"
  | "syncKnowledgeBases"
  | "refreshKnowledgeBases"
  | "resolveKnowledgeSyncConflict"
  | "restoreIgnoredRemoteKnowledgeBase"
>;
