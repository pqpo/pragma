import { ipcMain } from "electron";

import {
  AutomationActionSchema,
  AutomationAdapterOptionSchema,
  AutomationSchedulePreviewSchema,
  AutomationSummarySchema,
  DeleteAutomationSchema,
  PreviewAutomationScheduleSchema,
  SaveAutomationSchema,
} from "../shared/desktop-api.ts";
import type { AutomationService } from "./automation-service.ts";

export function installAutomationHandlers(service: AutomationService): void {
  ipcMain.handle("automations:adapters:list", () =>
    AutomationAdapterOptionSchema.array().parse(service.listAdapters()),
  );
  ipcMain.handle("automations:list", async () =>
    AutomationSummarySchema.array().parse(await service.list()),
  );
  ipcMain.handle("automations:save", async (_event, input: unknown) =>
    AutomationSummarySchema.parse(await service.save(SaveAutomationSchema.parse(input))),
  );
  ipcMain.handle("automations:delete", async (_event, input: unknown) => {
    await service.delete(DeleteAutomationSchema.parse(input));
  });
  ipcMain.handle("automations:session:reset", async (_event, input: unknown) => {
    const { ref } = AutomationActionSchema.parse(input);
    return AutomationSummarySchema.parse(await service.resetSession(ref));
  });
  ipcMain.handle("automations:schedule:preview", (_event, input: unknown) =>
    AutomationSchedulePreviewSchema.parse(
      service.preview(PreviewAutomationScheduleSchema.parse(input)),
    ),
  );
}
