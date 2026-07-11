import { ipcMain } from "electron";

import type { ExpertDefinitionStore } from "./expert-definition-store.ts";
import {
  CreateExpertDefinitionSchema,
  DeleteExpertDefinitionSchema,
  ExpertIdSchema,
  UpdateExpertDefinitionSchema,
} from "../shared/desktop-api.ts";

export function installExpertDefinitionHandlers(store: ExpertDefinitionStore): void {
  ipcMain.handle("experts:list", () => store.list());
  ipcMain.handle("experts:get", (_event, id: unknown) => store.get(ExpertIdSchema.parse(id)));
  ipcMain.handle("experts:create", (_event, input: unknown) =>
    store.create(CreateExpertDefinitionSchema.parse(input)),
  );
  ipcMain.handle("experts:update", (_event, id: unknown, input: unknown) =>
    store.update(ExpertIdSchema.parse(id), UpdateExpertDefinitionSchema.parse(input)),
  );
  ipcMain.handle("experts:delete", async (_event, input: unknown) => {
    await store.remove(DeleteExpertDefinitionSchema.parse(input).id);
  });
}
