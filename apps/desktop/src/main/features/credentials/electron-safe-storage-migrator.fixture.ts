import { createHash } from "node:crypto";
import { safeStorage } from "electron";
import { join, resolve } from "node:path";
import {
  SECRET_STORE_SERVICE,
  createNativeOsKeychain,
  createSecretStore,
} from "@pragma/local-host";

import { createCapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import { createModelProviderStore } from "../model-providers/model-provider-store.ts";
import { createPluginCredentialStore } from "../plugins/plugin-credential-store.ts";
import { createElectronSafeStorageLegacyDecryptor } from "../../platform/security/electron-safe-storage-legacy-decryptor.ts";

export async function migrateHistoricalCredentialData(dataRoot: string): Promise<void> {
  const data = join(dataRoot, "data");
  const credentials = join(data, "credentials");
  const secretStore = createSecretStore({
    root: join(credentials, "secret-store"),
    dataRoot: data,
    keychain: createNativeOsKeychain(),
  });
  const decryptor = createElectronSafeStorageLegacyDecryptor({
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
  const provider = createModelProviderStore({
    configPath: join(data, "model-providers.json"),
    secretStore,
    legacyDecryptor: decryptor,
  });
  const capability = createCapabilityCredentialStore({
    configPath: join(credentials, "capability-credentials.json"),
    secretStore,
    legacyDecryptor: decryptor,
  });
  const plugin = createPluginCredentialStore({
    configPath: join(credentials, "plugin-credentials.json"),
    secretStore,
    legacyDecryptor: decryptor,
  });

  await provider.resolveProvider("31a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6");
  await capability.get("capability-e07", "token");
  await plugin.get("binding:e07");
}

export async function deleteSecretStoreMasterKey(dataRoot: string): Promise<void> {
  const data = resolve(join(dataRoot, "data"));
  const account = `home:${createHash("sha256")
    .update(`${data}\u0000default`)
    .digest("hex")}:master-key:v1`;
  await createNativeOsKeychain()
    .delete(SECRET_STORE_SERVICE, account)
    .catch(() => undefined);
}
