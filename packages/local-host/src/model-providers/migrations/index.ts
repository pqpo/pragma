export { ModelProvidersV5Schema, type ModelProvidersV5 } from "./schemas/v5.ts";
export { ModelProvidersV6Schema } from "./schemas/v6.ts";
import { modelProvidersV5ToV6Step } from "./steps/v5-to-v6.ts";
import { modelProvidersV6ToV7Step } from "./steps/v6-to-v7.ts";

export { modelProvidersV5ToV6Step, modelProvidersV6ToV7Step };

export const MODEL_PROVIDER_STORAGE_VERSION = 7;
export const modelProviderStorageVersions = {
  currentVersion: MODEL_PROVIDER_STORAGE_VERSION,
  migratableVersions: [modelProvidersV5ToV6Step.fromVersion, modelProvidersV6ToV7Step.fromVersion],
} as const;
