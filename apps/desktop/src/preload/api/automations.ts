import { ipcRenderer } from "electron";

import {
  AutomationActionSchema,
  AutomationAdapterOptionSchema,
  AutomationSchedulePreviewSchema,
  AutomationSummarySchema,
  DeleteAutomationSchema,
  PreviewAutomationScheduleSchema,
  SaveAutomationSchema,
} from "../../shared/contracts/automations.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const automationsApi = {
  listAutomationAdapters: async () =>
    AutomationAdapterOptionSchema.array().parse(
      await ipcRenderer.invoke("automations:adapters:list"),
    ),
  listAutomations: async () =>
    AutomationSummarySchema.array().parse(await ipcRenderer.invoke("automations:list")),
  saveAutomation: async (input) =>
    AutomationSummarySchema.parse(
      await ipcRenderer.invoke("automations:save", SaveAutomationSchema.parse(input)),
    ),
  deleteAutomation: async (input) => {
    await ipcRenderer.invoke("automations:delete", DeleteAutomationSchema.parse(input));
  },
  triggerAutomation: async (ref) =>
    AutomationSummarySchema.parse(
      await ipcRenderer.invoke("automations:trigger", AutomationActionSchema.parse({ ref })),
    ),
  resetAutomationSession: async (ref) =>
    AutomationSummarySchema.parse(
      await ipcRenderer.invoke("automations:session:reset", AutomationActionSchema.parse({ ref })),
    ),
  previewAutomationSchedule: async (input) =>
    AutomationSchedulePreviewSchema.parse(
      await ipcRenderer.invoke(
        "automations:schedule:preview",
        PreviewAutomationScheduleSchema.parse(input),
      ),
    ),
} satisfies Pick<
  PragmaDesktopAPI,
  | "listAutomationAdapters"
  | "listAutomations"
  | "saveAutomation"
  | "deleteAutomation"
  | "triggerAutomation"
  | "resetAutomationSession"
  | "previewAutomationSchedule"
>;
