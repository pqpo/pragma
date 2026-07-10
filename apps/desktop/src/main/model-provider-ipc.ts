import { ipcMain } from "electron";

import { testOpenAiCompatibleModel } from "./model-connectivity.ts";
import type { ModelProviderStore } from "./model-provider-store.ts";
import {
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  ModelConnectionTestRequestSchema,
  UpdateModelProviderSchema,
} from "../shared/desktop-api.ts";

export function installModelProviderHandlers(store: ModelProviderStore): void {
  ipcMain.handle("model-providers:list", () => store.list());
  ipcMain.handle("model-providers:create", (_event, input: unknown) =>
    store.create(CreateModelProviderSchema.parse(input)),
  );
  ipcMain.handle("model-providers:update", (_event, input: unknown) =>
    store.update(UpdateModelProviderSchema.parse(input)),
  );
  ipcMain.handle("model-providers:delete", async (_event, input: unknown) => {
    await store.remove(DeleteModelProviderSchema.parse(input).id);
  });
  ipcMain.handle("model-providers:test", async (_event, input: unknown) => {
    const request = ModelConnectionTestRequestSchema.parse(input);
    try {
      const credentials = await store.getCredentials(request.providerId);
      if (!credentials.models.includes(request.modelId)) {
        return {
          ok: false,
          code: "model_unavailable" as const,
          message: "The model is not configured for this provider.",
        };
      }
      return await testOpenAiCompatibleModel({ ...credentials, modelId: request.modelId });
    } catch (error) {
      return {
        ok: false,
        code: "not_configured" as const,
        message: error instanceof Error ? error.message : "The provider could not be loaded.",
      };
    }
  });
}
