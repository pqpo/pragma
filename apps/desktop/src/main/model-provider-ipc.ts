import { ipcMain } from "electron";

import { testProviderModel } from "./model-connectivity.ts";
import { discoverProviderModels } from "./model-discovery.ts";
import type { ModelProviderStore } from "./model-provider-store.ts";
import {
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  DiscoverProviderModelsSchema,
  ModelConnectionTestRequestSchema,
  UpdateModelProviderSchema,
} from "../shared/desktop-api.ts";

export function installModelProviderHandlers(
  store: ModelProviderStore,
  options: {
    readonly isProviderReferenced?: (providerId: string) => Promise<boolean>;
  } = {},
): void {
  ipcMain.handle("model-providers:settings", () => store.getSnapshot());
  ipcMain.handle("model-providers:list", () => store.list());
  ipcMain.handle("model-providers:create", (_event, input: unknown) =>
    store.create(CreateModelProviderSchema.parse(input)),
  );
  ipcMain.handle("model-providers:update", (_event, input: unknown) =>
    store.update(UpdateModelProviderSchema.parse(input)),
  );
  ipcMain.handle("model-providers:delete", async (_event, input: unknown) => {
    const id = DeleteModelProviderSchema.parse(input).id;
    if (await options.isProviderReferenced?.(id)) {
      throw new Error("This provider is used by a Runtime Profile and cannot be deleted.");
    }
    await store.remove(id);
  });
  ipcMain.handle("model-providers:reset", () => store.reset());
  ipcMain.handle("model-providers:discover", async (_event, input: unknown) => {
    const request = DiscoverProviderModelsSchema.parse(input);
    let apiKey = request.apiKey ?? "";
    if (apiKey === "" && request.providerId !== undefined) {
      apiKey = await store.resolveDiscoveryApiKey(request.providerId, request);
    }
    return await discoverProviderModels({ ...request, apiKey });
  });
  ipcMain.handle("model-providers:test", async (_event, input: unknown) => {
    const request = ModelConnectionTestRequestSchema.parse(input);
    try {
      const resolved = await store.resolveProviderWithRevision(request.providerId);
      const provider = resolved.provider;
      const model =
        request.modelId === undefined
          ? provider.models[0]
          : provider.models.find((candidate) => candidate.id === request.modelId);
      if (model === undefined) {
        return {
          ok: false,
          code: "model_unavailable" as const,
          message: "The model is not configured for this provider.",
        };
      }
      const result = await testProviderModel({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        protocol: provider.api,
        model: { ...model, capabilitiesSource: "provider" },
      });
      await store.recordVerification(request.providerId, resolved.revision, result);
      return result;
    } catch (error) {
      return {
        ok: false,
        code: "not_configured" as const,
        message: error instanceof Error ? error.message : "The provider could not be loaded.",
      };
    }
  });
}
