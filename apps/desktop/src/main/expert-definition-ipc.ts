import { ipcMain } from "electron";

import type { ExpertDefinitionStore } from "./expert-definition-store.ts";
import {
  CreateExpertDefinitionSchema,
  DeleteExpertDefinitionSchema,
  ExpertRefSchema,
  ResetBuiltInExpertDefinitionSchema,
  UpdateBuiltInExpertDefinitionSchema,
  UpdateExpertDefinitionSchema,
} from "../shared/desktop-api.ts";
import { runDesktopMutation } from "./desktop-mutation-result.ts";

export function installExpertDefinitionHandlers(store: ExpertDefinitionStore): void {
  ipcMain.handle("experts:list", () => store.list());
  ipcMain.handle("experts:get", (_event, ref: unknown) => store.get(ExpertRefSchema.parse(ref)));
  ipcMain.handle("experts:create", (_event, input: unknown) =>
    runDesktopMutation(async () => await store.create(CreateExpertDefinitionSchema.parse(input))),
  );
  ipcMain.handle("experts:update", (_event, ref: unknown, input: unknown) =>
    runDesktopMutation(
      async () =>
        await store.update(ExpertRefSchema.parse(ref), UpdateExpertDefinitionSchema.parse(input)),
    ),
  );
  ipcMain.handle("experts:update-built-in", (_event, ref: unknown, input: unknown) =>
    runDesktopMutation(
      async () =>
        await store.updateBuiltIn(
          ExpertRefSchema.parse(ref),
          UpdateBuiltInExpertDefinitionSchema.parse(input),
        ),
    ),
  );
  ipcMain.handle("experts:reset-built-in", (_event, input: unknown) =>
    runDesktopMutation(
      async () => await store.resetBuiltIn(ResetBuiltInExpertDefinitionSchema.parse(input).ref),
    ),
  );
  ipcMain.handle("experts:delete", (_event, input: unknown) =>
    runDesktopMutation(
      async () => await store.remove(DeleteExpertDefinitionSchema.parse(input).ref),
    ),
  );
}
