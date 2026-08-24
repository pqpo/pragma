import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ModelProviderDefinition,
  ModelProviderRegistry,
  ResolvedModelProvider,
} from "@pragma/core";
import { withFileLock } from "@pragma/core";
import {
  SecretStoreError,
  type LegacyCredentialDecryptor,
  type SecretRef,
  type SecretStore,
} from "@pragma/local-host";
import { ProviderModelDefinitionSchema } from "@pragma/shared";
import { SecretRefSchema } from "@pragma/shared/integration";
import { z } from "zod";

import type {
  CreateModelProvider,
  ModelConnectionTestResult,
  ModelProvider,
  ModelProviderModel,
  ModelProviderSettingsSnapshot,
  ModelProviderVerification,
  ResetModelProvidersResult,
  UpdateModelProvider,
} from "../../../shared/contracts/index.ts";
import {
  ModelProviderModelSchema,
  ModelProviderSchema,
  ModelProviderVerificationSchema,
} from "../../../shared/contracts/index.ts";
import { findModelProviderPreset } from "../../../shared/model-provider-presets.ts";
import {
  migrateLegacyCredentialAggregate,
  type LegacySecretRecord,
} from "../credentials/legacy-credential-migration.ts";
import { ModelProvidersV4Schema, modelProvidersV4ToV5Step } from "./migrations/index.ts";

const CONFIG_SCHEMA_VERSION = 5;

interface StoredModelProvider {
  readonly id: string;
  readonly presetId: string;
  readonly name: string;
  readonly protocol: ModelProvider["protocol"];
  readonly baseUrl: string;
  readonly compatibilityProfileId?: string | undefined;
  readonly models: readonly ModelProviderModel[];
  readonly apiKeySecretRef?: SecretRef | undefined;
  readonly requiresApiKey: boolean;
  readonly verification: ModelProviderVerification;
  readonly revision: number;
}

interface StoredModelProviderConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly providers: readonly StoredModelProvider[];
}

interface LegacyStoredModelProvider extends Omit<StoredModelProvider, "apiKeySecretRef"> {
  readonly encryptedApiKey: string;
}
interface LegacyStoredModelProviderConfig {
  readonly schemaVersion: 4;
  readonly providers: readonly LegacyStoredModelProvider[];
}

export interface ModelProviderStore extends ModelProviderRegistry {
  getSnapshot(): Promise<ModelProviderSettingsSnapshot>;
  list(): Promise<ModelProvider[]>;
  create(input: CreateModelProvider): Promise<ModelProvider>;
  update(input: UpdateModelProvider): Promise<ModelProvider>;
  remove(id: string): Promise<void>;
  reset(): Promise<ResetModelProvidersResult>;
  resolveDiscoveryApiKey(
    id: string,
    connection: { readonly protocol: ModelProvider["protocol"]; readonly baseUrl: string },
  ): Promise<string>;
  resolveProviderWithRevision(
    id: string,
  ): Promise<{ readonly provider: ResolvedModelProvider; readonly revision: number }>;
  recordVerification(
    id: string,
    expectedRevision: number,
    result: ModelConnectionTestResult,
  ): Promise<ModelProviderVerification>;
  migrateLegacy?(): Promise<boolean>;
}

export class ModelProviderStoreError extends Error {
  constructor(
    readonly code:
      | "config_invalid"
      | "migration_required"
      | "provider_not_found"
      | "secret_unavailable"
      | "invalid_base_url"
      | "connection_changed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelProviderStoreError";
  }
}

function normalizeModels(models: readonly ModelProviderModel[]): ModelProviderModel[] {
  const normalized = models.map((model) =>
    ModelProviderModelSchema.parse({ ...model, id: model.id.trim(), name: model.name.trim() }),
  );
  if (new Set(normalized.map((model) => model.id)).size !== normalized.length) {
    throw new ModelProviderStoreError(
      "config_invalid",
      "Each model ID must be unique within a provider.",
    );
  }
  return normalized;
}

export function normalizeModelProviderBaseUrl(baseUrl: string): string {
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
    presetId: provider.presetId,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    ...(provider.compatibilityProfileId === undefined
      ? {}
      : { compatibilityProfileId: provider.compatibilityProfileId }),
    models: provider.models.map((model) => ({ ...model })),
    hasApiKey: provider.apiKeySecretRef !== undefined,
    requiresApiKey: provider.requiresApiKey,
    verification: provider.verification,
    revision: provider.revision,
  };
}

function parseConfig(raw: string): StoredModelProviderConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ModelProviderStoreError(
      "config_invalid",
      "The model provider configuration is unreadable and must be archived before continuing.",
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
      "This model provider configuration uses an older format and must be reconfigured.",
    );
  }

  let providers: StoredModelProvider[];
  try {
    providers = (value as { providers: unknown[] }).providers.map((candidate) => {
      if (!candidate || typeof candidate !== "object") invalidStoredProvider();
      const provider = candidate as Partial<StoredModelProvider>;
      if (
        typeof provider.id !== "string" ||
        typeof provider.presetId !== "string" ||
        typeof provider.name !== "string" ||
        typeof provider.baseUrl !== "string" ||
        "encryptedApiKey" in provider ||
        (provider.apiKeySecretRef !== undefined && !isSecretRef(provider.apiKeySecretRef)) ||
        typeof provider.requiresApiKey !== "boolean" ||
        !Number.isSafeInteger(provider.revision) ||
        (provider.revision ?? 0) <= 0 ||
        !Array.isArray(provider.models) ||
        typeof provider.protocol !== "string" ||
        provider.protocol.trim() === ""
      ) {
        invalidStoredProvider();
      }
      const stored = {
        ...provider,
        models: provider.models!.map((model) => ModelProviderModelSchema.parse(model)),
        verification: ModelProviderVerificationSchema.parse(provider.verification),
      } as StoredModelProvider;
      ModelProviderSchema.parse(toPublicProvider(stored));
      return stored;
    });
  } catch (error) {
    if (error instanceof z.ZodError) invalidStoredProvider();
    throw error;
  }
  return { schemaVersion: CONFIG_SCHEMA_VERSION, providers };
}

function parseCurrentConfig(value: unknown): StoredModelProviderConfig {
  return parseConfig(JSON.stringify(value));
}

function parseLegacyConfig(value: unknown): LegacyStoredModelProviderConfig {
  return ModelProvidersV4Schema.parse(value) as unknown as LegacyStoredModelProviderConfig;
}

function isSecretRef(value: unknown): value is SecretRef {
  return SecretRefSchema.safeParse(value).success;
}

function toMigratedProvider(
  provider: LegacyStoredModelProvider,
  refs: ReadonlyMap<string, SecretRef>,
): StoredModelProvider {
  const migrated = { ...provider } as Record<string, unknown>;
  delete migrated["encryptedApiKey"];
  return {
    ...migrated,
    ...(refs.has(provider.id) ? { apiKeySecretRef: refs.get(provider.id)! } : {}),
  } as StoredModelProvider;
}

function invalidStoredProvider(): never {
  throw new ModelProviderStoreError(
    "config_invalid",
    "The model provider configuration contains invalid data and must be reconfigured.",
  );
}

export function createModelProviderStore(options: {
  readonly configPath: string;
  readonly secretStore: SecretStore;
  readonly legacyDecryptor?: LegacyCredentialDecryptor | undefined;
}): ModelProviderStore {
  const migrateLegacy = async (): Promise<boolean> =>
    (
      await migrateLegacyCredentialAggregate<
        LegacyStoredModelProviderConfig,
        StoredModelProviderConfig
      >({
        configPath: options.configPath,
        family: "pragma.model-providers",
        sourceVersion: modelProvidersV4ToV5Step.fromVersion,
        targetVersion: modelProvidersV4ToV5Step.toVersion,
        secretStore: options.secretStore,
        decryptor: options.legacyDecryptor,
        parseLegacy: parseLegacyConfig,
        parseCurrent: parseCurrentConfig,
        collect: (legacy) =>
          legacy.providers
            .filter((provider) => provider.encryptedApiKey !== "")
            .map(
              (provider) =>
                ({
                  key: provider.id,
                  ciphertext: provider.encryptedApiKey,
                  owner: { kind: "model-provider", providerId: provider.id },
                }) satisfies LegacySecretRecord,
            ),
        target: (legacy, refs) => ({
          schemaVersion: 5,
          providers: legacy.providers.map((provider) => toMigratedProvider(provider, refs)),
        }),
      })
    ).migrated;
  const readConfig = async (): Promise<StoredModelProviderConfig> => {
    try {
      const raw = JSON.parse(await readFile(options.configPath, "utf8")) as unknown;
      if ((raw as { schemaVersion?: unknown }).schemaVersion === 4) {
        if (options.legacyDecryptor === undefined)
          throw new ModelProviderStoreError(
            "migration_required",
            "Open the upgraded Desktop to migrate model provider credentials.",
          );
        await migrateLegacy();
        return await readConfig();
      }
      return parseCurrentConfig(raw);
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

  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    return await withFileLock(`${options.configPath}.lock`, operation);
  };

  const requireProvider = async (id: string): Promise<StoredModelProvider> => {
    const provider = (await readConfig()).providers.find((item) => item.id === id);
    if (!provider) {
      throw new ModelProviderStoreError("provider_not_found", "The provider no longer exists.");
    }
    return provider;
  };

  const decryptApiKey = async (provider: StoredModelProvider): Promise<string> => {
    if (provider.apiKeySecretRef === undefined) return "";
    try {
      const value = await options.secretStore.get(provider.apiKeySecretRef);
      try {
        return value.utf8();
      } finally {
        value.dispose();
      }
    } catch (error) {
      if (
        error instanceof SecretStoreError &&
        (error.code === "SECRET_STORE_LOCKED" || error.code === "KEYCHAIN_UNAVAILABLE")
      )
        throw error;
      throw new ModelProviderStoreError(
        "secret_unavailable",
        "The saved API key cannot be decrypted on this device. Update the provider with a new key.",
        { cause: error },
      );
    }
  };

  const resolveStoredProvider = async (
    provider: StoredModelProvider,
  ): Promise<ResolvedModelProvider> => {
    return {
      id: provider.id,
      catalogId: provider.presetId,
      displayName: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: await decryptApiKey(provider),
      models: provider.models.map(toProviderModelDefinition),
      api: provider.protocol,
      ...(provider.compatibilityProfileId === undefined
        ? {}
        : { compatibilityProfileId: provider.compatibilityProfileId }),
      credentialFingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            id: provider.id,
            baseUrl: provider.baseUrl,
            compatibilityProfileId: provider.compatibilityProfileId,
            models: provider.models,
            protocol: provider.protocol,
            apiKeySecretRef: provider.apiKeySecretRef,
          }),
        )
        .digest("hex"),
    };
  };

  return {
    migrateLegacy,
    async getSnapshot(): Promise<ModelProviderSettingsSnapshot> {
      try {
        return { status: "ready", providers: (await readConfig()).providers.map(toPublicProvider) };
      } catch (error) {
        if (error instanceof ModelProviderStoreError && error.code === "config_invalid") {
          return {
            status: "reset_required",
            providers: [],
            legacyConfigPath: options.configPath,
            message: error.message,
          };
        }
        throw error;
      }
    },

    async list(): Promise<ModelProvider[]> {
      return (await readConfig()).providers.map(toPublicProvider);
    },

    async listProviders(): Promise<readonly ModelProviderDefinition[]> {
      return (await readConfig()).providers.map((provider) => ({
        id: provider.id,
        catalogId: provider.presetId,
        displayName: provider.name,
        api: provider.protocol,
        baseUrl: provider.baseUrl,
        ...(provider.compatibilityProfileId === undefined
          ? {}
          : { compatibilityProfileId: provider.compatibilityProfileId }),
        models: provider.models.map(toProviderModelDefinition),
      }));
    },

    async create(input: CreateModelProvider): Promise<ModelProvider> {
      validatePreset(input);
      if (input.requiresApiKey && input.apiKey === "") {
        throw new ModelProviderStoreError("config_invalid", "Enter an API key for this provider.");
      }
      return await mutate(async () => {
        const config = await readConfig();
        const id = randomUUID();
        const provider: StoredModelProvider = {
          id,
          presetId: input.presetId,
          name: input.name.trim(),
          protocol: input.protocol,
          baseUrl: normalizeModelProviderBaseUrl(input.baseUrl),
          ...(input.compatibilityProfileId === undefined
            ? {}
            : { compatibilityProfileId: input.compatibilityProfileId }),
          models: normalizeModels(input.models),
          ...(input.apiKey === ""
            ? {}
            : {
                apiKeySecretRef: await options.secretStore.put({
                  owner: { kind: "model-provider", providerId: id },
                  value: Buffer.from(input.apiKey),
                }),
              }),
          requiresApiKey: input.requiresApiKey,
          verification: { status: "unverified" },
          revision: 1,
        };
        await writeConfig({ ...config, providers: [...config.providers, provider] });
        return toPublicProvider(provider);
      });
    },

    async update(input: UpdateModelProvider): Promise<ModelProvider> {
      validatePreset(input);
      return await mutate(async () => {
        const config = await readConfig();
        const existing = config.providers.find((provider) => provider.id === input.id);
        if (!existing) {
          throw new ModelProviderStoreError("provider_not_found", "The provider no longer exists.");
        }
        const baseUrl = normalizeModelProviderBaseUrl(input.baseUrl);
        const connectionChanged =
          existing.protocol !== input.protocol || existing.baseUrl !== baseUrl;
        if (
          connectionChanged &&
          existing.apiKeySecretRef !== undefined &&
          input.apiKey === undefined
        ) {
          throw new ModelProviderStoreError(
            "connection_changed",
            "Re-enter the API key after changing the provider protocol or base URL.",
          );
        }
        const apiKeySecretRef =
          input.apiKey === undefined
            ? existing.apiKeySecretRef
            : input.apiKey === ""
              ? undefined
              : await options.secretStore.put({
                  owner: { kind: "model-provider", providerId: existing.id },
                  value: Buffer.from(input.apiKey),
                  ...(existing.apiKeySecretRef === undefined
                    ? {}
                    : { expectedRevision: existing.apiKeySecretRef.revision }),
                });
        if (input.requiresApiKey && apiKeySecretRef === undefined) {
          throw new ModelProviderStoreError(
            "config_invalid",
            "Enter an API key for this provider.",
          );
        }
        const provider: StoredModelProvider = {
          ...existing,
          presetId: input.presetId,
          name: input.name.trim(),
          protocol: input.protocol,
          baseUrl,
          ...(input.compatibilityProfileId === undefined
            ? { compatibilityProfileId: undefined }
            : { compatibilityProfileId: input.compatibilityProfileId }),
          models: normalizeModels(input.models),
          ...(apiKeySecretRef === undefined ? {} : { apiKeySecretRef }),
          requiresApiKey: input.requiresApiKey,
          verification: { status: "unverified" },
          revision: existing.revision + 1,
        };
        await writeConfig({
          ...config,
          providers: config.providers.map((item) => (item.id === provider.id ? provider : item)),
        });
        return toPublicProvider(provider);
      });
    },

    async remove(id: string): Promise<void> {
      await mutate(async () => {
        const config = await readConfig();
        if (!config.providers.some((provider) => provider.id === id)) {
          throw new ModelProviderStoreError("provider_not_found", "The provider no longer exists.");
        }
        await writeConfig({
          ...config,
          providers: config.providers.filter((provider) => provider.id !== id),
        });
      });
    },

    async reset(): Promise<ResetModelProvidersResult> {
      return await mutate(async () => {
        let backupPath: string | undefined;
        try {
          backupPath = `${options.configPath}.backup-${new Date().toISOString().replaceAll(":", "-")}`;
          await rename(options.configPath, backupPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          backupPath = undefined;
        }
        await writeConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, providers: [] });
        return {
          status: "ready",
          providers: [],
          ...(backupPath === undefined ? {} : { backupPath }),
        };
      });
    },

    async resolveDiscoveryApiKey(id, connection): Promise<string> {
      const provider = await requireProvider(id);
      const requestedBaseUrl = normalizeModelProviderBaseUrl(connection.baseUrl);
      if (provider.protocol !== connection.protocol || provider.baseUrl !== requestedBaseUrl) {
        throw new ModelProviderStoreError(
          "connection_changed",
          "Re-enter the API key after changing the provider protocol or base URL.",
        );
      }
      return await decryptApiKey(provider);
    },

    async recordVerification(id, expectedRevision, result): Promise<ModelProviderVerification> {
      return await mutate(async () => {
        const config = await readConfig();
        const existing = config.providers.find((provider) => provider.id === id);
        if (!existing) {
          throw new ModelProviderStoreError("provider_not_found", "The provider no longer exists.");
        }
        if (existing.revision !== expectedRevision) {
          throw new ModelProviderStoreError(
            "connection_changed",
            "The provider changed while the connection test was running. Test it again.",
          );
        }
        const verification: ModelProviderVerification = {
          status: result.ok ? "verified" : "failed",
          checkedAt: new Date().toISOString(),
          ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
          code: result.code,
          message: result.message,
          revision: existing.revision,
        };
        await writeConfig({
          ...config,
          providers: config.providers.map((provider) =>
            provider.id === id ? { ...provider, verification } : provider,
          ),
        });
        return verification;
      });
    },

    async resolveProviderWithRevision(id) {
      const provider = await requireProvider(id);
      return { provider: await resolveStoredProvider(provider), revision: provider.revision };
    },

    async resolveProvider(id): Promise<ResolvedModelProvider> {
      return await resolveStoredProvider(await requireProvider(id));
    },
  };
}

function toProviderModelDefinition(model: ModelProviderModel) {
  return ProviderModelDefinitionSchema.parse(model);
}

function validatePreset(input: {
  readonly presetId: string;
  readonly protocol: ModelProvider["protocol"];
  readonly requiresApiKey: boolean;
}): void {
  const preset = findModelProviderPreset(input.presetId);
  if (preset === undefined) {
    throw new ModelProviderStoreError("config_invalid", "Choose a supported provider preset.");
  }
  if (preset.requiresApiKey !== input.requiresApiKey) {
    throw new ModelProviderStoreError(
      "config_invalid",
      "The provider credential requirements do not match its preset.",
    );
  }
  if (preset.id !== "custom-openai" && preset.protocol !== input.protocol) {
    throw new ModelProviderStoreError(
      "config_invalid",
      "The provider protocol does not match its preset.",
    );
  }
}
