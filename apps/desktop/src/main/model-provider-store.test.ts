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
      baseUrl: "https://api.openai.com/v1/",
      apiKey: "sk-top-secret",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    });

    expect(provider).toMatchObject({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
      hasApiKey: true,
    });
    expect(await store.list()).toEqual([provider]);
    expect(await store.getCredentials(provider.id)).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-top-secret",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    });

    const rawConfig = await readFile(configPath, "utf8");
    expect(rawConfig).not.toContain("sk-top-secret");
    expect(rawConfig).toContain(Buffer.from("encrypted:sk-top-secret").toString("base64"));
  });

  it("retains the encrypted API key when updating provider metadata", async () => {
    const { store } = await createStore();
    const created = await store.create({
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-original",
      models: ["gpt-4.1"],
    });

    const updated = await store.update({
      id: created.id,
      name: "Company gateway",
      baseUrl: "https://models.example.com/v1",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    });

    expect(updated).toMatchObject({ name: "Company gateway", hasApiKey: true });
    expect(await store.getCredentials(created.id)).toEqual({
      baseUrl: "https://models.example.com/v1",
      apiKey: "sk-original",
      models: ["gpt-4.1", "gpt-4.1-mini"],
    });
  });

  it("rejects duplicate model IDs and plaintext fallback when encryption is unavailable", async () => {
    const { configPath, store } = await createStore();

    await expect(
      store.create({
        name: "OpenAI",
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
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: ["gpt-4.1"],
      }),
    ).rejects.toMatchObject({ code: "encryption_unavailable" } satisfies Partial<ModelProviderStoreError>);
  });
});
