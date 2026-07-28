import { ipcMain } from "electron";
import { generatePragmaResourceId } from "@pragma/core";
import { runPragmaFlowDrySuite } from "@pragma/interpreter";

import {
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PublishPragmaProjectSchema,
  RunPragmaFlowDrySuiteSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaResourceSchema,
  ValidatePragmaYamlSchema,
} from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";

export function installPragmaProjectHandlers(store: PragmaProjectStore): void {
  ipcMain.handle("pragma-project:get", () => store.get());
  ipcMain.handle("pragma-project:allocate-id", async () => {
    const used = new Set((await store.get()).resources.map((resource) => resource.metadata.id));
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const id = generatePragmaResourceId();
      if (!used.has(id)) return { id };
    }
    throw new Error("Could not allocate a unique Pragma resource ID.");
  });
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
  ipcMain.handle("pragma-project:flow:run-dry", (_event, input: unknown) => {
    const parsed = RunPragmaFlowDrySuiteSchema.parse(input);
    return runPragmaFlowDrySuite(parsed.flow);
  });
}
