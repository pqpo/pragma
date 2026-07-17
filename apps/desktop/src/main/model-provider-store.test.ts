import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      name: "OpenAI",
      protocol: "openai-completions",
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-top-secret",
      models: ["gpt-4.1", "gpt-4.1-mini"],
      modelMetadata: {
        "gpt-4.1": {
          displayName: "GPT 4.1",
          thinking: {
            supportedLevels: [{ value: "high", label: "High" }],
            defaultLevel: "high",
          },
        },
      },
    });

    expect(provider).toMatchObject({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
      modelMetadata: expect.objectContaining({
        "gpt-4.1": expect.objectContaining({ displayName: "GPT 4.1" }),
      }),
      hasApiKey: true,
    });
    expect(await store.list()).toEqual([provider]);
    expect(await store.getCredentials(provider.id)).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-top-secret",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    });
    await expect(store.listRuntimeModels()).resolves.toEqual([
      expect.objectContaining({
        id: "gpt-4.1",
        displayName: "GPT 4.1",
        provider: expect.objectContaining({ kind: "registered", id: provider.id }),
        thinking: expect.objectContaining({ defaultLevel: "high" }),
      }),
      expect.objectContaining({ id: "gpt-4.1-mini", displayName: "gpt-4.1-mini" }),
    ]);

    const rawConfig = await readFile(configPath, "utf8");
    expect(rawConfig).not.toContain("sk-top-secret");
    expect(rawConfig).toContain(Buffer.from("encrypted:sk-top-secret").toString("base64"));
  });

  it("retains the encrypted API key when updating provider metadata", async () => {
    const { store } = await createStore();
    const created = await store.create({
      name: "OpenAI",
      protocol: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-original",
      models: ["gpt-4.1"],
    });
    const before = (await store.getCredentials(created.id)).revision;

    const updated = await store.update({
      id: created.id,
      name: "Company gateway",
      protocol: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    });

    expect(updated).toMatchObject({ name: "Company gateway", hasApiKey: true });
    expect(await store.getCredentials(created.id)).toMatchObject({
      baseUrl: "https://models.example.com/v1",
      apiKey: "sk-original",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    });
    expect((await store.getCredentials(created.id)).revision).not.toBe(before);
  });

  it("rejects duplicate model IDs and plaintext fallback when encryption is unavailable", async () => {
    const { configPath, store } = await createStore();

    await expect(
      store.create({
        name: "OpenAI",
        protocol: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: ["gpt-4.1", "gpt-4.1"],
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
        name: "OpenAI",
        protocol: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: ["gpt-4.1"],
      }),
    ).rejects.toMatchObject({
      code: "encryption_unavailable",
    } satisfies Partial<ModelProviderStoreError>);
  });
});
