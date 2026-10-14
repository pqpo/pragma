export { PluginCredentialsV1Schema } from "./schemas/v1.ts";
import { pluginCredentialsV1ToV2Step } from "./steps/v1-to-v2.ts";

export { pluginCredentialsV1ToV2Step };

export const PLUGIN_CREDENTIAL_STORAGE_VERSION = 2;
export const pluginCredentialStorageVersions = {
  currentVersion: PLUGIN_CREDENTIAL_STORAGE_VERSION,
  migratableVersions: [pluginCredentialsV1ToV2Step.fromVersion],
} as const;
