import { ipcRenderer } from "electron";

import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
import {
  ResolveSkillSyncConflictSchema,
  RestoreIgnoredRemoteSkillSchema,
  SkillSyncOverviewSchema,
  UpdateSkillSyncConfigurationSchema,
} from "../../shared/contracts/index.ts";
import { invokeMutation } from "../invoke-mutation.ts";

export const skillSyncApi = {
  getSkillSyncOverview: async () =>
    SkillSyncOverviewSchema.parse(await ipcRenderer.invoke("skill-sync:get")),
  updateSkillSyncConfiguration: async (input) =>
    SkillSyncOverviewSchema.parse(
      await invokeMutation("skill-sync:configure", UpdateSkillSyncConfigurationSchema.parse(input)),
    ),
  removeSkillSyncConfiguration: async () => {
    await invokeMutation("skill-sync:remove");
  },
  syncSkills: async () => SkillSyncOverviewSchema.parse(await invokeMutation("skill-sync:run")),
  refreshSkills: async () =>
    SkillSyncOverviewSchema.parse(await invokeMutation("skill-sync:refresh")),
  resolveSkillSyncConflict: async (input) =>
    SkillSyncOverviewSchema.parse(
      await invokeMutation("skill-sync:resolve", ResolveSkillSyncConflictSchema.parse(input)),
    ),
  restoreIgnoredRemoteSkill: async (input) =>
    SkillSyncOverviewSchema.parse(
      await invokeMutation("skill-sync:restore", RestoreIgnoredRemoteSkillSchema.parse(input)),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "getSkillSyncOverview"
  | "updateSkillSyncConfiguration"
  | "removeSkillSyncConfiguration"
  | "syncSkills"
  | "refreshSkills"
  | "resolveSkillSyncConflict"
  | "restoreIgnoredRemoteSkill"
>;
