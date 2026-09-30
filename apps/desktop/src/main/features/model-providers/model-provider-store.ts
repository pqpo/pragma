import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ModelProviderDefinition,
  ModelProviderRegistry,
  ResolvedModelProvider,
} from "@pragma/core";
import { withFileLock } from "@pragma/core";
import {
  SecretStoreError,
  readStoredModelProviderConfig,
  readStoredModelProviderConfigUnderLock,
  ModelProvidersV5Schema,
  type ModelProvidersV5,
  MODEL_PROVIDER_STORAGE_VERSION,
  type LegacyCredentialDecryptor,
  type SecretRef,
  type SecretStore,
} from "@pragma/local-host";
import { ProviderModelDefinitionSchema } from "@pragma/shared";
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
import { ModelProviderModelSchema } from "../../../shared/contracts/index.ts";
import { findModelProviderPreset } from "../../../shared/model-provider-presets.ts";
import {
  migrateLegacyCredentialAggregate,
  type LegacySecretRecord,
} from "../credentials/legacy-credential-migration.ts";
import { ModelProvidersV4Schema, modelProvidersV4ToV5Step } from "./migrations/index.ts";

const CONFIG_SCHEMA_VERSION = MODEL_PROVIDER_STORAGE_VERSION;

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

function parseLegacyConfig(value: unknown): LegacyStoredModelProviderConfig {
  return ModelProvidersV4Schema.parse(value) as unknown as LegacyStoredModelProviderConfig;
}

function parseV5Config(value: unknown): ModelProvidersV5 {
  return ModelProvidersV5Schema.parse(value);
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
  const migrateLegacy = async (): Promise<boolean> => {
    const credentialJournalPath = `${options.configPath}.migration-journal.json`;
    if (!(await fileExists(credentialJournalPath))) {
      const currentVersion = await readConfigVersion(options.configPath);
      if (currentVersion === undefined || currentVersion >= modelProvidersV4ToV5Step.toVersion) {
        return false;
      }
    }
    return (
      await migrateLegacyCredentialAggregate<LegacyStoredModelProviderConfig, ModelProvidersV5>({
        configPath: options.configPath,
        family: "pragma.model-providers",
        sourceVersion: modelProvidersV4ToV5Step.fromVersion,
        targetVersion: modelProvidersV4ToV5Step.toVersion,
        secretStore: options.secretStore,
        decryptor: options.legacyDecryptor,
        parseLegacy: parseLegacyConfig,
        parseCurrent: parseV5Config,
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
        target: (legacy, refs) =>
          parseV5Config({
            schemaVersion: 5,
            providers: legacy.providers.map((provider) => toMigratedProvider(provider, refs)),
          }),
      })
    ).migrated;
  };
  const readConfig = async (): Promise<StoredModelProviderConfig> => {
    const version = await readConfigVersion(options.configPath);
    if (version === 4 || (await fileExists(`${options.configPath}.migration-journal.json`))) {
      if (options.legacyDecryptor === undefined)
        throw new ModelProviderStoreError(
          "migration_required",
          "Open Desktop to migrate model provider credentials.",
        );
      await migrateLegacy();
    }
    try {
      return await readStoredModelProviderConfig(options.configPath);
    } catch (error) {
      if (error instanceof z.ZodError) invalidStoredProvider();
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

  const mutate = async <T>(
    operation: (config: StoredModelProviderConfig) => Promise<T>,
  ): Promise<T> => {
    await readConfig();
    return await withFileLock(`${options.configPath}.lock`, async () => {
      const config = await readStoredModelProviderConfigUnderLock(options.configPath);
      return await operation(config);
    });
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
      return await mutate(async (config) => {
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
      return await mutate(async (config) => {
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
      await mutate(async (config) => {
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
      return await withFileLock(`${options.configPath}.lock`, async () => {
        let backupPath: string | undefined;
        const timestamp = new Date().toISOString().replaceAll(":", "-");
        const stateMigrationJournalPath = `${options.configPath}.state-migration.json`;
        if (await fileExists(stateMigrationJournalPath)) {
          await rename(
            stateMigrationJournalPath,
            `${options.configPath}.backup-${timestamp}.state-migration.json`,
          );
        }
        try {
          backupPath = `${options.configPath}.backup-${timestamp}`;
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
      return await mutate(async (config) => {
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readConfigVersion(path: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      value !== null &&
      typeof value === "object" &&
      Number.isInteger((value as { schemaVersion?: unknown }).schemaVersion)
    ) {
      return (value as { schemaVersion: number }).schemaVersion;
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function toProviderModelDefinition(model: ModelProviderModel) {
  const { capabilitiesSource, ...definition } = model;
  void capabilitiesSource;
  return ProviderModelDefinitionSchema.parse(definition);
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
