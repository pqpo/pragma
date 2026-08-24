import type { LegacyCredentialDecryptor } from "@pragma/local-host";

import type { CredentialEncryption } from "./credential-encryption.ts";

/**
 * The sole Desktop bridge for historical Electron safeStorage ciphertext. This
 * adapter is passed only to targeted migration code; no new credential write
 * path may depend on it.
 */
export function createElectronSafeStorageLegacyDecryptor(
  encryption: CredentialEncryption,
): LegacyCredentialDecryptor {
  return {
    kind: "electron-safe-storage",
    isAvailable: () => encryption.isAvailable(),
    decrypt: (ciphertext) => Buffer.from(encryption.decrypt(Buffer.from(ciphertext)), "utf8"),
  };
}
