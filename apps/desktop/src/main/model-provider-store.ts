import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  CreateModelProvider,
  ModelProvider,
  UpdateModelProvider,
} from "../shared/desktop-api.ts";

const CONFIG_SCHEMA_VERSION = 1;

interface StoredModelProvider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly encryptedApiKey: string;
}

interface StoredModelProviderConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly providers: readonly StoredModelProvider[];
}

export interface ModelProviderEncryption {
  readonly isAvailable: () => boolean;
  readonly encrypt: (plainText: string) => Buffer;
  readonly decrypt: (encrypted: Buffer) => string;
}

export interface ModelProviderStore {
  list(): Promise<ModelProvider[]>;
  create(input: CreateModelProvider): Promise<ModelProvider>;
  update(input: UpdateModelProvider): Promise<ModelProvider>;
  remove(id: string): Promise<void>;
  getCredentials(id: string): Promise<{
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly models: readonly string[];
    readonly revision: string;
  }>;
}

export class ModelProviderStoreError extends Error {
  constructor(
    readonly code:
      | "config_invalid"
      | "encryption_unavailable"
      | "provider_not_found"
      | "secret_unavailable"
      | "invalid_base_url",
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderStoreError";
  }
}

function ensureEncryption(encryption: ModelProviderEncryption): void {
  if (!encryption.isAvailable()) {
    throw new ModelProviderStoreError(
      "encryption_unavailable",
      "Secure storage is unavailable on this device. API keys cannot be saved.",
    );
  }
}

function normalizeModels(models: readonly string[]): string[] {
  const unique = new Set(models.map((model) => model.trim()));
  if (unique.size !== models.length) {
    throw new ModelProviderStoreError(
      "config_invalid",
      "Each model ID must be unique within a provider.",
    );
  }
  return [...unique];
}

function normalizeBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelProviderStoreError("invalid_base_url", "Enter a valid API base URL.");
  }

  const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new ModelProviderStoreError(
      "invalid_base_url",
      "API base URLs must use HTTPS, except for a local loopback server.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ModelProviderStoreError(
      "invalid_base_url",
      "API base URL cannot contain credentials, queries, or fragments.",
    );
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function toPublicProvider(provider: StoredModelProvider): ModelProvider {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: [...provider.models],
    hasApiKey: provider.encryptedApiKey.length > 0,
  };
}

function parseConfig(raw: string): StoredModelProviderConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ModelProviderStoreError(
      "config_invalid",
      "The model provider configuration file is not valid JSON.",
    );
  }

  if (
    !value ||
    typeof value !== "object" ||
    (value as { schemaVersion?: unknown }).schemaVersion !== CONFIG_SCHEMA_VERSION ||
    !Array.isArray((value as { providers?: unknown }).providers)
  ) {
    throw new ModelProviderStoreError(
      "config_invalid",
      "The model provider configuration has an unsupported format.",
    );
  }

  const providers = (value as { providers: unknown[] }).providers.map((provider) => {
    if (
      !provider ||
      typeof provider !== "object" ||
      typeof (provider as StoredModelProvider).id !== "string" ||
      typeof (provider as StoredModelProvider).name !== "string" ||
      typeof (provider as StoredModelProvider).baseUrl !== "string" ||
      typeof (provider as StoredModelProvider).encryptedApiKey !== "string" ||
      !Array.isArray((provider as StoredModelProvider).models) ||
      !(provider as StoredModelProvider).models.every((model) => typeof model === "string")
    ) {
      throw new ModelProviderStoreError(
        "config_invalid",
        "The model provider configuration contains invalid data.",
      );
    }
    return provider as StoredModelProvider;
  });

  return { schemaVersion: CONFIG_SCHEMA_VERSION, providers };
}

export function createModelProviderStore(options: {
  readonly configPath: string;
  readonly encryption: ModelProviderEncryption;
}): ModelProviderStore {
  const readConfig = async (): Promise<StoredModelProviderConfig> => {
    try {
      return parseConfig(await readFile(options.configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: CONFIG_SCHEMA_VERSION, providers: [] };
      }
      throw error;
    }
  };

  const writeConfig = async (config: StoredModelProviderConfig): Promise<void> => {
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.configPath), 0o700).catch(() => undefined);
    const temporaryPath = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, options.configPath);
    await chmod(options.configPath, 0o600).catch(() => undefined);
  };

  return {
    async list(): Promise<ModelProvider[]> {
      return (await readConfig()).providers.map(toPublicProvider);
    },

    async create(input: CreateModelProvider): Promise<ModelProvider> {
      ensureEncryption(options.encryption);
      const config = await readConfig();
      const provider: StoredModelProvider = {
        id: randomUUID(),
        name: input.name.trim(),
        baseUrl: normalizeBaseUrl(input.baseUrl),
        models: normalizeModels(input.models),
        encryptedApiKey: options.encryption.encrypt(input.apiKey).toString("base64"),
      };
      await writeConfig({ ...config, providers: [...config.providers, provider] });
      return toPublicProvider(provider);
    },

    async update(input: UpdateModelProvider): Promise<ModelProvider> {
      const config = await readConfig();
      const existing = config.providers.find((provider) => provider.id === input.id);
      if (!existing) {
        throw new ModelProviderStoreError("provider_not_found", "The provider no longer exists.");
      }
      if (input.apiKey !== undefined) ensureEncryption(options.encryption);
      const provider: StoredModelProvider = {
        ...existing,
        name: input.name.trim(),
        baseUrl: normalizeBaseUrl(input.baseUrl),
        models: normalizeModels(input.models),
        ...(input.apiKey === undefined
          ? {}
          : { encryptedApiKey: options.encryption.encrypt(input.apiKey).toString("base64") }),
      };
      await writeConfig({
        ...config,
        providers: config.providers.map((item) => (item.id === provider.id ? provider : item)),
      });
      return toPublicProvider(provider);
    },

    async remove(id: string): Promise<void> {
      const config = await readConfig();
      if (!config.providers.some((provider) => provider.id === id)) {
        throw new ModelProviderStoreError("provider_not_found", "The provider no longer exists.");
      }
      await writeConfig({
        ...config,
        providers: config.providers.filter((provider) => provider.id !== id),
      });
    },

    async getCredentials(id: string): Promise<{
      readonly baseUrl: string;
      readonly apiKey: string;
      readonly models: readonly string[];
      readonly revision: string;
    }> {
      ensureEncryption(options.encryption);
      const provider = (await readConfig()).providers.find((item) => item.id === id);
      if (!provider) {
        throw new ModelProviderStoreError("provider_not_found", "The provider no longer exists.");
      }
      try {
        return {
          baseUrl: provider.baseUrl,
          apiKey: options.encryption.decrypt(Buffer.from(provider.encryptedApiKey, "base64")),
          models: provider.models,
          revision: createHash("sha256")
            .update(
              JSON.stringify({
                id: provider.id,
                baseUrl: provider.baseUrl,
                models: provider.models,
                api: "openai-completions",
                encryptedApiKey: provider.encryptedApiKey,
              }),
            )
            .digest("hex"),
        };
      } catch {
        throw new ModelProviderStoreError(
          "secret_unavailable",
          "The saved API key cannot be decrypted on this device. Update the provider with a new key.",
        );
      }
    },
  };
}
