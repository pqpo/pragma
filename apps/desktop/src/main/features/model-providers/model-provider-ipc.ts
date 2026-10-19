import { ipcMain } from "electron";
import { listPiCompatibilityProfiles } from "@pragma/runtime-pi";

import { testProviderModel } from "./model-connectivity.ts";
import { discoverProviderModels } from "./model-discovery.ts";
import {
  createModelConnectionService,
  type ModelProviderStore,
} from "@pragma/local-host/deployment";
import {
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  DiscoverProviderModelsSchema,
  ModelConnectionTestRequestSchema,
  UpdateModelProviderSchema,
} from "../../../shared/contracts/index.ts";

export function installModelProviderHandlers(
  store: ModelProviderStore,
  options: {
    readonly runtimes?: import("@pragma/local-host/deployment").RuntimeEnvironmentService;
    readonly project?: Pick<import("@pragma/local-host/deployment").PragmaProjectStore, "get">;
    readonly externalResources?: () => readonly import("@pragma/interpreter/ast").PragmaResource[];
    readonly beforeConnectionChange?: () => void;
  } = {},
): void {
  const service = createModelConnectionService({
    store,
    discover: discoverProviderModels,
    test: testProviderModel,
    ...options,
  });
  ipcMain.handle("model-providers:settings", () => store.getSnapshot());
  ipcMain.handle("model-providers:compatibility-profiles", () => listPiCompatibilityProfiles());
  ipcMain.handle("model-providers:list", () => store.list());
  ipcMain.handle("model-providers:create", (_event, input: unknown) =>
    service.create(CreateModelProviderSchema.parse(input)),
  );
  ipcMain.handle("model-providers:update", (_event, input: unknown) =>
    service.update(UpdateModelProviderSchema.parse(input), { scope: "shared" }),
  );
  ipcMain.handle("model-providers:delete", (_event, input: unknown) =>
    service.remove(DeleteModelProviderSchema.parse(input).id),
  );
  ipcMain.handle("model-providers:reset", () => service.reset());
  ipcMain.handle("model-providers:discover", (_event, input: unknown) =>
    service.discover({
      ...DiscoverProviderModelsSchema.parse(input),
      apiKey: DiscoverProviderModelsSchema.parse(input).apiKey ?? "",
    }),
  );
  ipcMain.handle("model-providers:test", (_event, input: unknown) =>
    service.test(ModelConnectionTestRequestSchema.parse(input)),
  );
}
