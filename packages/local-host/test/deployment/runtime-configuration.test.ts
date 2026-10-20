import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PragmaPaths } from "@pragma/core";
import { createSecretStore, type OsKeychain } from "../../src/index.ts";
import {
  createLocalHostRuntimeConfiguration,
  createRuntimeEnvironmentService,
} from "../../src/deployment/index.ts";

describe("shared Runtime configuration", () => {
  it("reopens Desktop authority and SecretRefs without copying secrets or rewriting revisions", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-configuration-"));
    const paths = new PragmaPaths({ pragmaHome });
    const keys = new Map<string, Uint8Array>();
    let locked = false;
    const keychain: OsKeychain = {
      inspect: async () =>
        locked
          ? { status: "locked", backend: "macos-keychain", reasonCode: "KEYCHAIN_LOCKED" }
          : { status: "ready", backend: "macos-keychain" },
      get: async (service, account) => keys.get(`${service}/${account}`) ?? null,
      set: async (service, account, value) => {
        keys.set(`${service}/${account}`, value);
      },
      delete: async (service, account) => {
        keys.delete(`${service}/${account}`);
      },
    };
    const open = () =>
      createLocalHostRuntimeConfiguration({
        pragmaHome,
        secretStore: createSecretStore({
          root: paths.secretStoreRoot(),
          dataRoot: paths.dataRoot(),
          keychain,
        }),
      });
    try {
      const desktop = open();
      const provider = await desktop.modelProviders.create({
        presetId: "custom-openai",
        name: "Saved connection",
        protocol: "openai-completions",
        baseUrl: "https://example.test/v1",
        apiKey: "configuration-secret-canary",
        requiresApiKey: true,
        models: [
          {
            kind: "embedding",
            id: "embed",
            name: "Embedding",
            api: "openai-embeddings",
            maxInputTokens: 8192,
            cost: { input: 0 },
            capabilitiesSource: "manual",
          },
        ],
      });
      const first = await desktop.environments.create({
        schemaVersion: "pragma.runtime-environment/v1",
        origin: "registered",
        id: "saved-pi",
        displayName: "Saved Runtime",
        adapter: { id: "pragma.runtime.pi", version: "v1" },
        config: {},
      });
      await desktop.environments.update({
        expectedRevision: first.revision,
        definition: { ...first.definition, displayName: "Updated Runtime" },
      });
      const cli = open();
      expect(await cli.modelProviders.resolveProvider(provider.id)).toMatchObject({
        id: provider.id,
        apiKey: "configuration-secret-canary",
        baseUrl: "https://example.test/v1",
      });
      expect(await cli.environments.getRevision(first.runtimeId, first.revision)).toEqual(first);
      const service = createRuntimeEnvironmentService({ store: cli.environments, factories: [] });
      await expect(
        service.resolve({
          binding: {
            runtimeId: first.runtimeId,
            revision: first.revision,
            fingerprint: "invalid",
          },
        }),
      ).rejects.toThrow("binding is unavailable");
      await expect(service.bind({ runtimeId: "missing-runtime" })).rejects.toThrow("not active");
      locked = true;
      await expect(open().modelProviders.resolveProvider(provider.id)).rejects.toMatchObject({
        code: "SECRET_STORE_LOCKED",
      });
      expect(await readFile(paths.modelProviders(), "utf8")).not.toContain(
        "configuration-secret-canary",
      );
      await expect(cli.modelProviders.resolveProvider("missing-provider")).rejects.toMatchObject({
        code: "provider_not_found",
      });
    } finally {
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });
});
