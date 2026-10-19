import { PragmaPaths } from "@pragma/core";
import {
  createNativeOsKeychain,
  createSecretStore,
  type LegacyCredentialDecryptor,
  type SecretStore,
} from "../../secrets/index.ts";
import { createModelProviderStore } from "../model-providers/model-provider-store.ts";
import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";
import type { RuntimeEnvironmentDefinition } from "../../deployment-contracts/index.ts";

/** Both surfaces read the same authority and SecretRefs; adapters stay in the apps. */
export function createLocalHostRuntimeConfiguration(options: {
  readonly pragmaHome: string;
  readonly secretStore?: SecretStore | undefined;
  readonly legacyDecryptor?: LegacyCredentialDecryptor | undefined;
}) {
  const paths = new PragmaPaths(options);
  const secretStore =
    options.secretStore ??
    createSecretStore({
      root: paths.secretStoreRoot(),
      dataRoot: paths.dataRoot(),
      keychain: createNativeOsKeychain(),
    });
  return {
    modelProviders: createModelProviderStore({
      configPath: paths.modelProviders(),
      secretStore,
      legacyDecryptor: options.legacyDecryptor,
    }),
    environments: createRuntimeEnvironmentStore({ pragmaHome: options.pragmaHome }),
  };
}

export function assertEmptyBuiltInRuntimeConfig(environment: RuntimeEnvironmentDefinition): void {
  if (Object.keys(environment.config).length > 0) {
    throw new Error(`Built-in Runtime Environment config must be empty: ${environment.id}.`);
  }
}
