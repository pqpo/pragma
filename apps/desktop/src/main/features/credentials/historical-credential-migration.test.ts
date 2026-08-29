import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecretStore } from "@pragma/local-host";
import { afterEach, describe, expect, it } from "vitest";

import {
  HISTORICAL_CREDENTIAL_WRITER_COMMIT,
  historicalSafeStorageDecrypt,
  writeHistoricalCapabilityCredentialsV1,
  writeHistoricalModelProviderV4,
  writeHistoricalPluginCredentialsV1,
} from "./historical-credential-writers.fixture.ts";
import { createCapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import { createModelProviderStore } from "../model-providers/model-provider-store.ts";
import { createPluginCredentialStore } from "../plugins/plugin-credential-store.ts";
import { TestKeychain, createTestSecretStore } from "./test-secret-store.ts";

const roots: string[] = [];

afterEach(
  async () =>
    await Promise.all(
      roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
    ),
);

const legacyDecryptor = {
  kind: "electron-safe-storage" as const,
  isAvailable: () => true,
  decrypt: historicalSafeStorageDecrypt,
};

describe("historical credential writer migration chain", () => {
  it("migrates v4/v1 historical writer output and lets a separate CLI Host read the same secret revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-historical-credentials-"));
    roots.push(root);
    const data = join(root, "data");
    const providerPath = join(data, "model-providers.json");
    const capabilityPath = join(data, "credentials", "capability-credentials.json");
    const pluginPath = join(data, "credentials", "plugin-credentials.json");
    const providerId = "31a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6";
    const keychain = new TestKeychain();
    const desktopSecretStore = createTestSecretStore(
      join(data, "credentials", "secret-store"),
      keychain,
    ).secretStore;

    await writeHistoricalModelProviderV4({
      path: providerPath,
      providerId,
      apiKey: "provider-historical-secret",
    });
    await writeHistoricalCapabilityCredentialsV1(capabilityPath, {
      "capability-a/token": "capability-historical-secret",
    });
    await writeHistoricalPluginCredentialsV1(pluginPath, {
      "binding:historical": "plugin-historical-secret",
    });
    // These bytes are frozen from bcd2ed01's `Buffer.from("encrypted:${plain}")`
    // historical writer, not derived by the current fixture helper.
    expect(JSON.parse(await readFile(providerPath, "utf8"))).toMatchObject({
      schemaVersion: 4,
      providers: [{ encryptedApiKey: "ZW5jcnlwdGVkOnByb3ZpZGVyLWhpc3RvcmljYWwtc2VjcmV0" }],
    });
    expect(JSON.parse(await readFile(capabilityPath, "utf8"))).toEqual({
      schemaVersion: 1,
      credentials: { "capability-a/token": "ZW5jcnlwdGVkOmNhcGFiaWxpdHktaGlzdG9yaWNhbC1zZWNyZXQ=" },
    });
    expect(JSON.parse(await readFile(pluginPath, "utf8"))).toEqual({
      schemaVersion: 1,
      credentials: { "binding:historical": "ZW5jcnlwdGVkOnBsdWdpbi1oaXN0b3JpY2FsLXNlY3JldA==" },
    });

    const desktopProviders = createModelProviderStore({
      configPath: providerPath,
      secretStore: desktopSecretStore,
      legacyDecryptor,
    });
    const desktopCapabilities = createCapabilityCredentialStore({
      configPath: capabilityPath,
      secretStore: desktopSecretStore,
      legacyDecryptor,
    });
    const desktopPlugins = createPluginCredentialStore({
      configPath: pluginPath,
      secretStore: desktopSecretStore,
      legacyDecryptor,
    });

    await expect(desktopProviders.resolveProvider(providerId)).resolves.toMatchObject({
      apiKey: "provider-historical-secret",
    });
    await expect(desktopCapabilities.get("capability-a", "token")).resolves.toBe(
      "capability-historical-secret",
    );
    await expect(desktopPlugins.get("binding:historical")).resolves.toBe(
      "plugin-historical-secret",
    );

    const cliSecretStore = createSecretStore({
      root: join(data, "credentials", "secret-store"),
      keychain,
    });
    const providerRef = providerRefFrom(await readFile(providerPath, "utf8"));
    const capabilityRef = credentialRefFrom(
      await readFile(capabilityPath, "utf8"),
      "capability-a/token",
    );
    const pluginRef = credentialRefFrom(await readFile(pluginPath, "utf8"), "binding:historical");
    await expect(readSecret(cliSecretStore, providerRef)).resolves.toBe(
      "provider-historical-secret",
    );
    await expect(readSecret(cliSecretStore, capabilityRef)).resolves.toBe(
      "capability-historical-secret",
    );
    await expect(readSecret(cliSecretStore, pluginRef)).resolves.toBe("plugin-historical-secret");

    for (const path of [providerPath, capabilityPath, pluginPath]) {
      const current = await readFile(path, "utf8");
      expect(current).not.toContain("provider-historical-secret");
      expect(current).not.toContain("capability-historical-secret");
      expect(current).not.toContain("plugin-historical-secret");
      expect(current).not.toContain("encryptedApiKey");
    }
    expect(HISTORICAL_CREDENTIAL_WRITER_COMMIT).toBe("bcd2ed01");
  });

  it("allows only one Desktop migration owner while a concurrent CLI Host fails closed until the migration commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-migration-race-"));
    roots.push(root);
    const configPath = join(root, "data", "credentials", "plugin-credentials.json");
    const keychain = new TestKeychain();
    const secretRoot = join(root, "data", "credentials", "secret-store");
    await writeHistoricalPluginCredentialsV1(configPath, { "binding:race": "race-secret" });

    let writes = 0;
    const firstSecretStore = countSecretWrites(
      createTestSecretStore(secretRoot, keychain).secretStore,
      () => {
        writes += 1;
      },
    );
    const secondSecretStore = countSecretWrites(
      createTestSecretStore(secretRoot, keychain).secretStore,
      () => {
        writes += 1;
      },
    );
    const first = createPluginCredentialStore({
      configPath,
      secretStore: firstSecretStore,
      legacyDecryptor,
    });
    const second = createPluginCredentialStore({
      configPath,
      secretStore: secondSecretStore,
      legacyDecryptor,
    });
    const cli = createPluginCredentialStore({
      configPath,
      secretStore: createSecretStore({ root: secretRoot, keychain }),
    });

    await expect(cli.migrateLegacy!()).rejects.toMatchObject({ code: "SECRET_MIGRATION_REQUIRED" });
    await Promise.all([first.migrateLegacy!(), second.migrateLegacy!()]);
    expect(writes).toBe(1);
    await expect(cli.get("binding:race")).resolves.toBe("race-secret");
  });

  it("uses symmetric structured migration-required errors when all three legacy families lack a decryptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-migration-required-"));
    roots.push(root);
    const data = join(root, "data");
    const secretStore = createTestSecretStore(
      join(data, "credentials", "secret-store"),
    ).secretStore;
    const providerPath = join(data, "model-providers.json");
    const capabilityPath = join(data, "credentials", "capability-credentials.json");
    const pluginPath = join(data, "credentials", "plugin-credentials.json");
    await writeHistoricalModelProviderV4({
      path: providerPath,
      providerId: "31a1b2c3-d4e5-46f7-89a0-b1c2d3e4f5a6",
      apiKey: "never-in-error",
    });
    await writeHistoricalCapabilityCredentialsV1(capabilityPath, {
      "capability/token": "never-in-error",
    });
    await writeHistoricalPluginCredentialsV1(pluginPath, { "binding:test": "never-in-error" });

    const provider = createModelProviderStore({ configPath: providerPath, secretStore });
    const capability = createCapabilityCredentialStore({ configPath: capabilityPath, secretStore });
    const plugin = createPluginCredentialStore({ configPath: pluginPath, secretStore });
    const errors = await Promise.allSettled([
      provider.list(),
      capability.get("capability", "token"),
      plugin.get("binding:test"),
    ]);
    for (const result of errors) {
      expect(result).toMatchObject({ status: "rejected", reason: { code: "migration_required" } });
      const reason = (result as PromiseRejectedResult).reason;
      expect(`${reason.message}${JSON.stringify(reason)}`).not.toContain("never-in-error");
      expect(`${reason.message}${JSON.stringify(reason)}`).not.toContain("encrypted:");
    }
  });
});

function providerRefFrom(raw: string) {
  return (
    JSON.parse(raw) as {
      providers: readonly { apiKeySecretRef: import("@pragma/local-host").SecretRef }[];
    }
  ).providers[0]!.apiKeySecretRef;
}

function countSecretWrites(
  store: import("@pragma/local-host").SecretStore,
  onPut: () => void,
): import("@pragma/local-host").SecretStore {
  return {
    ...store,
    put: async (input) => {
      onPut();
      return await store.put(input);
    },
  };
}

function credentialRefFrom(raw: string, key: string) {
  return (
    JSON.parse(raw) as {
      credentials: Readonly<Record<string, import("@pragma/local-host").SecretRef>>;
    }
  ).credentials[key]!;
}

async function readSecret(
  store: import("@pragma/local-host").SecretStore,
  ref: import("@pragma/local-host").SecretRef,
): Promise<string> {
  const handle = await store.get(ref);
  try {
    return handle.utf8();
  } finally {
    handle.dispose();
  }
}
