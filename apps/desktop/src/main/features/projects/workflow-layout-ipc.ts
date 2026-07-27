import { ipcMain } from "electron";

import {
  DeleteWorkflowLayoutSchema,
  GetWorkflowLayoutSchema,
  WorkflowLayoutSchema,
} from "../../../shared/contracts/index.ts";
import type { WorkflowLayoutStore } from "./workflow-layout-store.ts";

export function installWorkflowLayoutHandlers(store: WorkflowLayoutStore): void {
  ipcMain.handle("workflow-layout:get", (_event, input: unknown) =>
    store.get(GetWorkflowLayoutSchema.parse(input)),
  );
  ipcMain.handle("workflow-layout:save", (_event, input: unknown) =>
    store.save(WorkflowLayoutSchema.parse(input)),
  );
  ipcMain.handle("workflow-layout:delete", (_event, input: unknown) =>
    store.remove(DeleteWorkflowLayoutSchema.parse(input)),
  );
}
