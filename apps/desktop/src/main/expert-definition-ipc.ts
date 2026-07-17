import { ipcMain } from "electron";

import type { ExpertDefinitionStore } from "./expert-definition-store.ts";
import {
  CreateExpertDefinitionSchema,
  DeleteExpertDefinitionSchema,
  ExpertRefSchema,
  UpdateExpertDefinitionSchema,
} from "../shared/desktop-api.ts";

export function installExpertDefinitionHandlers(store: ExpertDefinitionStore): void {
  ipcMain.handle("experts:list", () => store.list());
  ipcMain.handle("experts:get", (_event, ref: unknown) => store.get(ExpertRefSchema.parse(ref)));
  ipcMain.handle("experts:create", (_event, input: unknown) =>
    store.create(CreateExpertDefinitionSchema.parse(input)),
  );
  ipcMain.handle("experts:update", (_event, ref: unknown, input: unknown) =>
    store.update(ExpertRefSchema.parse(ref), UpdateExpertDefinitionSchema.parse(input)),
  );
  ipcMain.handle("experts:delete", async (_event, input: unknown) => {
    await store.remove(DeleteExpertDefinitionSchema.parse(input).ref);
  });
}
