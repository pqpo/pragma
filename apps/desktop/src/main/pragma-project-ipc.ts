import { ipcMain } from "electron";

import {
  DeletePragmaResourceSchema,
  PublishPragmaProjectSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaYamlSchema,
} from "../shared/desktop-api.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";

export function installPragmaProjectHandlers(store: PragmaProjectStore): void {
  ipcMain.handle("pragma-project:get", () => store.get());
  ipcMain.handle("pragma-project:publish", (_event, input: unknown) =>
    store.publish(PublishPragmaProjectSchema.parse(input)),
  );
  ipcMain.handle("pragma-project:upsert", (_event, input: unknown) =>
    store.upsert(UpsertPragmaResourceSchema.parse(input)),
  );
  ipcMain.handle("pragma-project:delete", (_event, input: unknown) =>
    store.remove(DeletePragmaResourceSchema.parse(input)),
  );
  ipcMain.handle("pragma-project:validate-yaml", (_event, input: unknown) =>
    store.validateYaml(ValidatePragmaYamlSchema.parse(input).source),
  );
}
