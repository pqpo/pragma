import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  SECRET_STORE_SERVICE,
  createNativeOsKeychain,
  createSecretStore,
} from "../src/index.ts";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

describe.runIf(process.platform === "darwin")("macOS native keychain cross-Host composition", () => {
  it("lets the Desktop composition write, close, then lets the CLI composition read", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-native-keychain-"));
    roots.push(root);
    const secretRoot = join(root, "data", "credentials", "secret-store");
    const desktopKeychain = createNativeOsKeychain();
    const cliKeychain = createNativeOsKeychain();
    const dataRoot = join(root, "data");
    const desktop = createSecretStore({ root: secretRoot, dataRoot, keychain: desktopKeychain });

    await expect(desktop.inspect()).resolves.toMatchObject({ status: "ready", backend: "macos-keychain" });
    const ref = await desktop.put({ owner: { kind: "plugin-binding", bindingRef: "binding:macos-e2e" }, value: Buffer.from("macos-cross-host-secret") });

    // A separate adapter instance mirrors the CLI process after Desktop exits.
    const cli = createSecretStore({ root: secretRoot, dataRoot, keychain: cliKeychain });
    const value = await cli.get(ref);
    try {
      expect(value.utf8()).toBe("macos-cross-host-secret");
    } finally {
      value.dispose();
      await cliKeychain.delete(SECRET_STORE_SERVICE, masterKeyAccount(dataRoot));
    }
  });
});

function masterKeyAccount(dataRoot: string): string {
  const homeId = createHash("sha256").update(`${resolve(dataRoot)}\u0000default`).digest("hex");
  return `home:${homeId}:master-key:v1`;
}
