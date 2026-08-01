import { ipcMain } from "electron";
import { parsePragmaReference } from "@pragma/interpreter/ast";

import type { ExpertDefinitionStore } from "./expert-definition-store.ts";
import type { DesktopUsageStore } from "../usage/usage-store.ts";
import {
  CreateExpertDefinitionSchema,
  DeleteExpertDefinitionSchema,
  ExpertRefSchema,
  ResetBuiltInExpertDefinitionSchema,
  UpdateBuiltInExpertDefinitionSchema,
  UpdateExpertDefinitionSchema,
} from "../../../shared/contracts/index.ts";
import { runDesktopMutation } from "../../platform/ipc/desktop-mutation-result.ts";

export function installExpertDefinitionHandlers(
  store: ExpertDefinitionStore,
  usage: DesktopUsageStore,
): void {
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
    runDesktopMutation(async () => {
      const ref = DeleteExpertDefinitionSchema.parse(input).ref;
      await store.remove(ref);
      usage.markSubjectDeleted("expert", parsePragmaReference(ref).id);
    }),
  );
}
