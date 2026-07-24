import { ipcMain } from "electron";

import {
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PublishPragmaProjectSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaResourceSchema,
  ValidatePragmaYamlSchema,
} from "../shared/desktop-api.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import { runDesktopMutation } from "./desktop-mutation-result.ts";

export function installPragmaProjectHandlers(store: PragmaProjectStore): void {
  ipcMain.handle("pragma-project:get", () => store.get());
  ipcMain.handle("pragma-project:publish", (_event, input: unknown) =>
    runDesktopMutation(async () => await store.publish(PublishPragmaProjectSchema.parse(input))),
  );
  ipcMain.handle("pragma-project:upsert", (_event, input: unknown) =>
    runDesktopMutation(async () => await store.upsert(UpsertPragmaResourceSchema.parse(input))),
  );
  ipcMain.handle("pragma-project:apply-changes", (_event, input: unknown) =>
    runDesktopMutation(async () => await store.apply(PragmaProjectChangesSchema.parse(input))),
  );
  ipcMain.handle("pragma-project:delete", (_event, input: unknown) =>
    runDesktopMutation(async () => await store.remove(DeletePragmaResourceSchema.parse(input))),
  );
  ipcMain.handle("pragma-project:validate-yaml", (_event, input: unknown) =>
    store.validateYaml(ValidatePragmaYamlSchema.parse(input).source),
  );
  ipcMain.handle("pragma-project:validate-resource", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = ValidatePragmaResourceSchema.parse(input);
      return await store.validateCandidate(parsed);
    }),
  );
  ipcMain.handle("pragma-project:validate-changes", (_event, input: unknown) =>
    runDesktopMutation(async () => {
      const parsed = PragmaProjectChangesSchema.parse(input);
      return { diagnostics: await store.validateChanges(parsed) };
    }),
  );
}
