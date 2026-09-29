import { createHash } from "node:crypto";
import { readFile, mkdir, copyFile, access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
  withFileLock,
  type ResolvedModelProvider,
} from "@pragma/core";
import { ConfiguredProviderModelSchema, type EmbeddingModelDefinition } from "@pragma/shared";
import { SecretRefSchema } from "@pragma/shared/integration";
import { z } from "zod";
import type { SecretStore } from "../secrets/secret-store.ts";
import {
  ModelProvidersV5Schema,
  ModelProvidersV6Schema,
  modelProvidersV5ToV6Step,
  modelProvidersV6ToV7Step,
} from "./migrations/index.ts";

export const MODEL_PROVIDER_STORAGE_VERSION = 7;
const VerificationSchema = z.object({
  status: z.enum(["unverified", "verified", "failed"]),
  checkedAt: z.string().datetime().optional(),
  latencyMs: z.number().nonnegative().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  revision: z.number().int().positive().optional(),
});
export const StoredModelProviderSchema = z.object({
  id: z.string().uuid(),
  presetId: z.string().min(1),
  name: z.string().min(1),
  protocol: z.string().min(1),
  baseUrl: z.string().url(),
  compatibilityProfileId: z.string().optional(),
  models: z.array(ConfiguredProviderModelSchema).min(1),
  apiKeySecretRef: SecretRefSchema.optional(),
  requiresApiKey: z.boolean(),
  verification: VerificationSchema,
  revision: z.number().int().positive(),
});
export const StoredModelProviderConfigSchema = z.object({
  schemaVersion: z.literal(MODEL_PROVIDER_STORAGE_VERSION),
  providers: z.array(StoredModelProviderSchema),
});
export type StoredModelProviderConfig = z.infer<typeof StoredModelProviderConfigSchema>;

export async function readStoredModelProviderConfig(
  path: string,
): Promise<StoredModelProviderConfig> {
  const read = async (): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { schemaVersion: MODEL_PROVIDER_STORAGE_VERSION, providers: [] };
      throw error;
    }
  };
  const first = await read();
  let hasJournal = false;
  try {
    await access(`${path}.state-migration.json`);
    hasJournal = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (
    !hasJournal &&
    typeof first === "object" &&
    first !== null &&
    "schemaVersion" in first &&
    first.schemaVersion === MODEL_PROVIDER_STORAGE_VERSION
  )
    return StoredModelProviderConfigSchema.parse(first);
  return await withFileLock(`${path}.lock`, async () => {
    const aggregateRoot = dirname(path),
      name = basename(path),
      journalFile = `${path}.state-migration.json`;
    const resource = { family: "pragma.model-providers", id: name };
    // Old unfinished v5 -> v6 journals must be replayed with their own target schema.
    await recoverAtomicStateMigration({
      aggregateRoot,
      journalFile,
      resource,
      validateDocuments: (documents) => {
        const value = documents[name];
        if (
          typeof value === "object" &&
          value !== null &&
          "schemaVersion" in value &&
          value.schemaVersion === 6
        )
          ModelProvidersV6Schema.parse(value);
        else StoredModelProviderConfigSchema.parse(value);
      },
    });
    let value = await read();
    for (const step of [modelProvidersV5ToV6Step, modelProvidersV6ToV7Step]) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("schemaVersion" in value) ||
        value.schemaVersion !== step.fromVersion
      )
        continue;
      const source =
        step.fromVersion === 5
          ? ModelProvidersV5Schema.parse(value)
          : ModelProvidersV6Schema.parse(value);
      const target =
        step.fromVersion === 5
          ? modelProvidersV5ToV6Step.migrate(ModelProvidersV5Schema.parse(source))
          : modelProvidersV6ToV7Step.migrate(ModelProvidersV6Schema.parse(source));
      const backupRoot = join(aggregateRoot, "migrations", "backups");
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      const hash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
      await copyFile(path, join(backupRoot, `${hash}.model-providers.v${step.fromVersion}.json`));
      await applyAtomicStateMigration({
        aggregateRoot,
        journalFile,
        resource,
        fromVersion: step.fromVersion,
        toVersion: step.toVersion,
        documents: { [name]: target },
        validateDocuments: (documents) => {
          if (step.toVersion === 6) ModelProvidersV6Schema.parse(documents[name]);
          else StoredModelProviderConfigSchema.parse(documents[name]);
        },
      });
      value = target;
    }
    return StoredModelProviderConfigSchema.parse(value);
  });
}
export function createModelProviderReader(options: {
  configPath: string;
  secretStore: SecretStore;
}) {
  return {
    read: () => readStoredModelProviderConfig(options.configPath),
    async resolveEmbedding(
      providerId: string,
      modelId: string,
    ): Promise<{
      model: EmbeddingModelDefinition;
      provider: ResolvedModelProvider;
      revision: number;
    }> {
      const provider = (await readStoredModelProviderConfig(options.configPath)).providers.find(
        (value) => value.id === providerId,
      );
      const model = provider?.models.find((value) => value.id === modelId);
      if (provider === undefined || model?.kind !== "embedding")
        throw new Error("embedding_model_unavailable");
      if (model.maxInputTokens === undefined) throw new Error("embedding_input_limit_required");
      let apiKey = "";
      if (provider.apiKeySecretRef !== undefined) {
        const handle = await options.secretStore.get(provider.apiKeySecretRef);
        try {
          apiKey = handle.utf8();
        } finally {
          handle.dispose();
        }
      }
      if (provider.requiresApiKey && apiKey === "") throw new Error("embedding_auth_required");
      return {
        model,
        revision: provider.revision,
        provider: {
          id: provider.id,
          catalogId: provider.presetId,
          displayName: provider.name,
          api: provider.protocol,
          baseUrl: provider.baseUrl,
          models: provider.models,
          apiKey,
          credentialFingerprint: createHash("sha256")
            .update(JSON.stringify(provider.apiKeySecretRef ?? null))
            .digest("hex"),
        },
      };
    },
  };
}
