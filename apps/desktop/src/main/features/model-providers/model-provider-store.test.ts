import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createModelProviderStore, ModelProviderStoreError } from "./model-provider-store.ts";
import { createTestSecretStore } from "../credentials/test-secret-store.ts";
import { ModelProvidersV5Schema, modelProvidersV5ToV6Step } from "./migrations/index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-model-providers-"));
  directories.push(directory);
  const { secretStore } = createTestSecretStore(join(directory, "secret-store"));
  return {
    configPath: join(directory, "model-providers.json"),
    store: createModelProviderStore({
      configPath: join(directory, "model-providers.json"),
      secretStore,
    }),
  };
}

describe("model provider store", () => {
  it("persists encrypted API keys while exposing only a key-presence flag", async () => {
    const { configPath, store } = await createStore();

    const provider = await store.create({
      presetId: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1/",
      compatibilityProfileId: "pi.openai-responses-modern@v1",
      apiKey: "sk-top-secret",
      requiresApiKey: true,
      models: [model("gpt-4.1", "GPT 4.1", true), model("gpt-4.1-mini")],
    });

    expect(provider).toMatchObject({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      compatibilityProfileId: "pi.openai-responses-modern@v1",
      models: [
        expect.objectContaining({ id: "gpt-4.1", name: "GPT 4.1" }),
        expect.objectContaining({ id: "gpt-4.1-mini" }),
      ],
      hasApiKey: true,
    });
    expect(await store.list()).toEqual([provider]);
    expect(await store.resolveProvider(provider.id)).toMatchObject({
      id: provider.id,
      displayName: "OpenAI",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      compatibilityProfileId: "pi.openai-responses-modern@v1",
      apiKey: "sk-top-secret",
      models: [
        expect.objectContaining({ id: "gpt-4.1" }),
        expect.objectContaining({ id: "gpt-4.1-mini" }),
      ],
    });
    await expect(store.listProviders()).resolves.toEqual([
      expect.objectContaining({
        id: provider.id,
        displayName: "OpenAI",
        models: [
          expect.objectContaining({ id: "gpt-4.1", name: "GPT 4.1", reasoning: true }),
          expect.objectContaining({ id: "gpt-4.1-mini" }),
        ],
      }),
    ]);
    expect((await store.listProviders())[0]?.models[0]).not.toHaveProperty("capabilitiesSource");

    const rawConfig = await readFile(configPath, "utf8");
    expect(rawConfig).not.toContain("sk-top-secret");
    expect(rawConfig).toContain("apiKeySecretRef");
  });

  it("treats legacy credential migration as a no-op for current v6 configuration", async () => {
    const { store } = await createStore();
    await store.create({
      presetId: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret",
      requiresApiKey: true,
      models: [model("gpt-4.1")],
    });

    await expect(store.migrateLegacy!()).resolves.toBe(false);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("retains the encrypted API key when updating provider metadata", async () => {
    const { store } = await createStore();
    const created = await store.create({
      presetId: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-original",
      requiresApiKey: true,
      models: [model("gpt-4.1")],
    });
    const before = (await store.resolveProvider(created.id)).credentialFingerprint;

    const updated = await store.update({
      id: created.id,
      presetId: "openai",
      name: "Renamed OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requiresApiKey: true,
      models: [model("gpt-4.1"), model("gpt-4.1-mini")],
    });

    expect(updated).toMatchObject({ name: "Renamed OpenAI", hasApiKey: true });
    expect(await store.resolveProvider(created.id)).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-original",
      models: [
        expect.objectContaining({ id: "gpt-4.1" }),
        expect.objectContaining({ id: "gpt-4.1-mini" }),
      ],
    });
    expect((await store.resolveProvider(created.id)).credentialFingerprint).not.toBe(before);
  });

  it("persists image input overrides while exposing only the effective runtime modalities", async () => {
    const { store } = await createStore();
    const visionModel = {
      ...model("qwen3.7-plus", "Qwen 3.7 Plus", true, "openai-completions"),
      input: ["text", "image"] as ("text" | "image")[],
      inputOverride: ["text", "image"] as ("text" | "image")[],
    };
    const provider = await store.create({
      presetId: "qwen",
      name: "Qwen / Bailian",
      protocol: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "secret",
      requiresApiKey: true,
      models: [visionModel],
    });

    expect(provider.models[0]).toMatchObject({
      input: ["text", "image"],
      inputOverride: ["text", "image"],
    });
    const runtimeModel = (await store.resolveProvider(provider.id)).models[0];
    expect(runtimeModel).toMatchObject({ input: ["text", "image"] });
    expect(runtimeModel).not.toHaveProperty("inputOverride");
  });

  it("migrates v5 limits, correcting known Qwen defaults and preserving unknown models", async () => {
    const { configPath, store } = await createStore();
    await store.create({
      presetId: "qwen",
      name: "Qwen / Bailian",
      protocol: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "secret",
      requiresApiKey: true,
      models: [
        model("qwen3.8-max", "Qwen3.8 Max", true, "openai-completions"),
        model("future-qwen", "Future Qwen", false, "openai-completions"),
      ],
    });
    const current = JSON.parse(await readFile(configPath, "utf8")) as {
      schemaVersion: number;
      providers: (Record<string, unknown> & { models: Record<string, unknown>[] })[];
      futureRoot?: unknown;
    };
    current.schemaVersion = 5;
    current.futureRoot = { retained: true };
    current.providers[0]!.futureProvider = { retained: true };
    current.providers[0]!.models[0]!.futureModel = { retained: true };
    for (const configuredModel of current.providers[0]!.models) {
      delete configuredModel["contextWindowSource"];
      delete configuredModel["maxTokensSource"];
    }
    await writeFile(configPath, JSON.stringify(current));

    const snapshot = await store.getSnapshot();

    expect(snapshot.providers[0]?.models).toEqual([
      expect.objectContaining({
        id: "qwen3.8-max",
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        contextWindowSource: "catalog",
        maxTokensSource: "catalog",
      }),
      expect.objectContaining({
        id: "future-qwen",
        contextWindow: 128_000,
        maxTokens: 16_384,
        contextWindowSource: "legacy",
        maxTokensSource: "legacy",
      }),
    ]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      schemaVersion: 6,
      futureRoot: { retained: true },
      providers: [
        expect.objectContaining({
          futureProvider: { retained: true },
          models: expect.arrayContaining([
            expect.objectContaining({ futureModel: { retained: true } }),
          ]),
        }),
      ],
    });
    await expect(readdir(join(dirname(configPath), "migrations", "backups"))).resolves.toHaveLength(
      1,
    );
  });

  it("replays an interrupted v5-to-v6 journal before reading providers", async () => {
    const { configPath, store } = await createStore();
    await store.create({
      presetId: "qwen",
      name: "Qwen / Bailian",
      protocol: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "secret",
      requiresApiKey: true,
      models: [model("qwen3.8-max", "Qwen3.8 Max", true, "openai-completions")],
    });
    const current = JSON.parse(await readFile(configPath, "utf8")) as {
      schemaVersion: number;
      providers: { models: Record<string, unknown>[] }[];
    };
    current.schemaVersion = 5;
    for (const configuredModel of current.providers[0]!.models) {
      delete configuredModel["contextWindowSource"];
      delete configuredModel["maxTokensSource"];
    }
    const source = ModelProvidersV5Schema.parse(current);
    const target = modelProvidersV5ToV6Step.migrate(source);
    await writeFile(configPath, JSON.stringify(source));
    const journalPath = `${configPath}.state-migration.json`;
    await writeFile(
      journalPath,
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.model-providers", id: "model-providers.json" },
        fromVersion: 5,
        toVersion: 6,
        documents: { "model-providers.json": target },
      }),
    );

    await expect(store.getSnapshot()).resolves.toMatchObject({
      status: "ready",
      providers: [
        {
          models: [expect.objectContaining({ id: "qwen3.8-max", contextWindow: 1_000_000 })],
        },
      ],
    });
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate model IDs and unavailable keychain writes", async () => {
    const { configPath, store } = await createStore();

    await expect(
      store.create({
        presetId: "openai",
        name: "OpenAI",
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        requiresApiKey: true,
        models: [model("gpt-4.1"), model("gpt-4.1")],
      }),
    ).rejects.toMatchObject({ code: "config_invalid" } satisfies Partial<ModelProviderStoreError>);

    const unavailable = createTestSecretStore(join(configPath, "unavailable"));
    unavailable.keychain.health = { status: "unavailable", backend: "macos-keychain" };
    const unavailableStore = createModelProviderStore({
      configPath,
      secretStore: unavailable.secretStore,
    });
    await expect(
      unavailableStore.create({
        presetId: "openai",
        name: "OpenAI",
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        requiresApiKey: true,
        models: [model("gpt-4.1")],
      }),
    ).rejects.toMatchObject({ code: "KEYCHAIN_UNAVAILABLE" });
  });

  it("archives unsupported configuration instead of attempting an implicit migration", async () => {
    const { configPath, store } = await createStore();
    await writeFile(configPath, JSON.stringify({ schemaVersion: 3, providers: [] }));

    await expect(store.getSnapshot()).resolves.toMatchObject({
      status: "reset_required",
      providers: [],
      legacyConfigPath: configPath,
    });
    const reset = await store.reset();

    expect(reset).toMatchObject({ status: "ready", providers: [], backupPath: expect.any(String) });
    await expect(access(reset.backupPath!)).resolves.toBeUndefined();
    await expect(store.getSnapshot()).resolves.toEqual({ status: "ready", providers: [] });
  });

  it("archives a pending state migration journal when resetting configuration", async () => {
    const { configPath, store } = await createStore();
    await store.create({
      presetId: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "secret",
      requiresApiKey: true,
      models: [model("gpt-4.1")],
    });
    const journalPath = `${configPath}.state-migration.json`;
    await writeFile(journalPath, JSON.stringify({ interrupted: true }));

    await expect(store.reset()).resolves.toMatchObject({ status: "ready", providers: [] });
    await expect(access(journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.getSnapshot()).resolves.toEqual({ status: "ready", providers: [] });
    expect(
      (await readdir(dirname(configPath))).some((entry) => entry.endsWith(".state-migration.json")),
    ).toBe(true);
  });

  it("offers archive and reset when a current-version provider has invalid nested data", async () => {
    const { configPath, store } = await createStore();
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 6,
        providers: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            presetId: "openai",
            name: "Broken",
            protocol: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "missing-required-model-fields" }],
            requiresApiKey: true,
            verification: { status: "unverified" },
            revision: 1,
          },
        ],
      }),
    );

    await expect(store.getSnapshot()).resolves.toMatchObject({
      status: "reset_required",
      providers: [],
      legacyConfigPath: configPath,
    });
  });

  it("reuses a saved key only for the provider connection it belongs to", async () => {
    const { store } = await createStore();
    const provider = await store.create({
      presetId: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-original",
      requiresApiKey: true,
      models: [model("gpt-4.1")],
    });

    await expect(
      store.resolveDiscoveryApiKey(provider.id, {
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1/",
      }),
    ).resolves.toBe("sk-original");
    await expect(
      store.resolveDiscoveryApiKey(provider.id, {
        protocol: "openai-responses",
        baseUrl: "https://collector.example.com/v1",
      }),
    ).rejects.toMatchObject({ code: "connection_changed" });
    await expect(
      store.resolveDiscoveryApiKey(provider.id, {
        protocol: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).rejects.toMatchObject({ code: "connection_changed" });
    await expect(
      store.update({
        id: provider.id,
        presetId: "custom-openai",
        name: "Changed endpoint",
        protocol: "openai-completions",
        baseUrl: "https://collector.example.com/v1",
        requiresApiKey: true,
        models: [model("gpt-4.1", "gpt-4.1", false, "openai-completions")],
      }),
    ).rejects.toMatchObject({ code: "connection_changed" });
  });

  it("does not record a connection result after the provider revision changes", async () => {
    const { store } = await createStore();
    const created = await store.create({
      presetId: "openai",
      name: "OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-original",
      requiresApiKey: true,
      models: [model("gpt-4.1")],
    });
    const tested = await store.resolveProviderWithRevision(created.id);
    const updated = await store.update({
      id: created.id,
      presetId: "openai",
      name: "Updated OpenAI",
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-new",
      requiresApiKey: true,
      models: [model("gpt-4.1")],
    });

    await expect(
      store.recordVerification(created.id, tested.revision, {
        ok: true,
        code: "success",
        message: "The old connection worked.",
      }),
    ).rejects.toMatchObject({ code: "connection_changed" });
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        name: "Updated OpenAI",
        revision: updated.revision,
        verification: { status: "unverified" },
      }),
    ]);
  });

  it("supports keyless local providers and persists verification against the saved revision", async () => {
    const { store } = await createStore();
    const provider = await store.create({
      presetId: "ollama",
      name: "Ollama",
      protocol: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      requiresApiKey: false,
      models: [model("qwen3", "qwen3", false, "openai-completions")],
    });

    await store.recordVerification(provider.id, provider.revision, {
      ok: false,
      code: "network",
      message: "Ollama is not running.",
    });

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        hasApiKey: false,
        verification: expect.objectContaining({
          status: "failed",
          revision: provider.revision,
          message: "Ollama is not running.",
        }),
      }),
    ]);
  });
});

function model(
  id: string,
  name = id,
  reasoning = false,
  api: "openai-completions" | "openai-responses" = "openai-responses",
) {
  return {
    id,
    name,
    api,
    reasoning,
    ...(reasoning
      ? {
          thinking: {
            supportedLevels: ["off" as const, "high" as const],
            defaultLevel: "high" as const,
          },
        }
      : {}),
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    capabilitiesSource: "manual" as const,
  };
}
