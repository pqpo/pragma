import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createModelProviderStore, ModelProviderStoreError } from "./model-provider-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-model-providers-"));
  directories.push(directory);
  return {
    configPath: join(directory, "model-providers.json"),
    store: createModelProviderStore({
      configPath: join(directory, "model-providers.json"),
      encryption: {
        isAvailable: () => true,
        encrypt: (plainText) => Buffer.from(`encrypted:${plainText}`),
        decrypt: (encrypted) => encrypted.toString().replace("encrypted:", ""),
      },
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
      apiKey: "sk-top-secret",
      requiresApiKey: true,
      models: [model("gpt-4.1", "GPT 4.1", true), model("gpt-4.1-mini")],
    });

    expect(provider).toMatchObject({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
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
    expect(rawConfig).toContain(Buffer.from("encrypted:sk-top-secret").toString("base64"));
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

  it("rejects duplicate model IDs and plaintext fallback when encryption is unavailable", async () => {
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

    const unavailableStore = createModelProviderStore({
      configPath,
      encryption: {
        isAvailable: () => false,
        encrypt: () => Buffer.alloc(0),
        decrypt: () => "",
      },
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
    ).rejects.toMatchObject({
      code: "encryption_unavailable",
    } satisfies Partial<ModelProviderStoreError>);
  });

  it("archives unsupported configuration instead of attempting an implicit migration", async () => {
    const { configPath, store } = await createStore();
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, providers: [] }));

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

  it("offers archive and reset when a current-version provider has invalid nested data", async () => {
    const { configPath, store } = await createStore();
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 3,
        providers: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            presetId: "openai",
            name: "Broken",
            protocol: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "missing-required-model-fields" }],
            encryptedApiKey: "",
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
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: null,
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
