import { describe, expect, it } from "vitest";

import { createElectronSafeStorageLegacyDecryptor } from "./electron-safe-storage-legacy-decryptor.ts";

describe("Electron safeStorage legacy decryptor", () => {
  it("only exposes migration-time decryption", () => {
    const decryptor = createElectronSafeStorageLegacyDecryptor({
      isAvailable: () => true,
      encrypt: (value) => Buffer.from(`old:${value}`),
      decrypt: (value) => value.toString("utf8").replace("old:", ""),
    });
    expect(decryptor).toMatchObject({ kind: "electron-safe-storage" });
    expect(Buffer.from(decryptor.decrypt(Buffer.from("old:secret"))).toString("utf8")).toBe("secret");
  });
});
