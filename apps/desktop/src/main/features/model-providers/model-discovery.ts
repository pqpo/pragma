import { createPiModelProviderDirectory } from "@pragma/runtime-pi";
import { createModelDiscovery } from "@pragma/local-host/deployment";
export const { discoverProviderModels, unknownModel } = createModelDiscovery(
  createPiModelProviderDirectory(),
);
