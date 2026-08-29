import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { withFileLock } from "@pragma/core";
import {
  SecretStoreError,
  type LegacyCredentialDecryptor,
  type SecretRef,
  type SecretStore,
} from "@pragma/local-host";
import { SecretRefSchema } from "@pragma/shared/integration";

import {
  migrateLegacyCredentialAggregate,
  type LegacySecretRecord,
} from "../credentials/legacy-credential-migration.ts";
import {
  CapabilityCredentialsV1Schema,
  capabilityCredentialsV1ToV2Step,
} from "./migrations/index.ts";

interface LegacyStoredCredentialConfig {
  readonly schemaVersion: 1;
  readonly credentials: Readonly<Record<string, string>>;
}
interface StoredCredentialConfig {
  readonly schemaVersion: 2;
  readonly credentials: Readonly<Record<string, SecretRef>>;
}

export interface CapabilityCredentialStore {
  setMany(capabilityId: string, credentials: Readonly<Record<string, string>>): Promise<void>;
  get(capabilityId: string, name: string): Promise<string | undefined>;
  removeCapability(capabilityId: string): Promise<void>;
  fingerprint(capabilityId: string): Promise<string>;
  migrateLegacy?(): Promise<boolean>;
}

export class CapabilityCredentialStoreError extends Error {
  constructor(
    readonly code: "config_invalid" | "secret_unavailable" | "migration_required",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CapabilityCredentialStoreError";
  }
}

export function createCapabilityCredentialStore(options: {
  readonly configPath: string;
  readonly secretStore: SecretStore;
  readonly legacyDecryptor?: LegacyCredentialDecryptor | undefined;
}): CapabilityCredentialStore {
  const lockPath = `${options.configPath}.lock`;
  const migrateLegacy = async (): Promise<boolean> => {
    const result = await migrateLegacyCredentialAggregate<
      LegacyStoredCredentialConfig,
      StoredCredentialConfig
    >({
      configPath: options.configPath,
      family: "pragma.capability-credentials",
      sourceVersion: capabilityCredentialsV1ToV2Step.fromVersion,
      targetVersion: capabilityCredentialsV1ToV2Step.toVersion,
      secretStore: options.secretStore,
      decryptor: options.legacyDecryptor,
      parseLegacy: parseLegacy,
      parseCurrent,
      collect: (legacy) =>
        Object.entries(legacy.credentials).map(([key, ciphertext]) => {
          const [capabilityId, name] = splitKey(key);
          return {
            key,
            ciphertext,
            owner: { kind: "capability", capabilityId, name },
          } satisfies LegacySecretRecord;
        }),
      target: (legacy, refs) => ({
        schemaVersion: 2,
        credentials: Object.fromEntries(
          Object.keys(legacy.credentials).map((key) => [key, refs.get(key)!]),
        ),
      }),
    });
    return result.migrated;
  };
  const readConfig = async (): Promise<StoredCredentialConfig> => {
    try {
      const raw = JSON.parse(await readFile(options.configPath, "utf8")) as unknown;
      if (version(raw) === 1) {
        if (options.legacyDecryptor === undefined)
          throw new CapabilityCredentialStoreError(
            "migration_required",
            "Open the upgraded Desktop to migrate capability credentials.",
          );
        await migrateLegacy();
        return await readConfig();
      }
      return parseCurrent(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 2, credentials: {} };
      if (error instanceof CapabilityCredentialStoreError) throw error;
      throw new CapabilityCredentialStoreError(
        "config_invalid",
        "The capability credential store has an unsupported format.",
        { cause: error },
      );
    }
  };
  const writeConfig = async (config: StoredCredentialConfig): Promise<void> => {
    // The generic migration writer owns durable upgrades. Normal mutations use the
    // same aggregate lock and atomic replacement from the existing store contract.
    const { mkdir, chmod, rename, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.configPath), 0o700).catch(() => undefined);
    const temporary = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, options.configPath);
    await chmod(options.configPath, 0o600).catch(() => undefined);
  };
  return {
    migrateLegacy,
    async setMany(capabilityId, credentials) {
      if (Object.keys(credentials).length === 0) return;
      await migrateLegacy();
      await withFileLock(
        lockPath,
        async () => {
          const current = await readConfig();
          const next = { ...current.credentials } as Record<string, SecretRef>;
          for (const [name, value] of Object.entries(credentials)) {
            const key = `${capabilityId}/${name}`;
            const existing = next[key];
            next[key] = await options.secretStore.put({
              owner: { kind: "capability", capabilityId, name },
              value: Buffer.from(value),
              ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
            });
          }
          await writeConfig({ schemaVersion: 2, credentials: next });
        },
        { operation: "capability-credentials.mutate" },
      );
    },
    async get(capabilityId, name) {
      const ref = (await readConfig()).credentials[`${capabilityId}/${name}`];
      if (ref === undefined) return undefined;
      try {
        const value = await options.secretStore.get(ref);
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
        throw new CapabilityCredentialStoreError(
          "secret_unavailable",
          `The saved credential ${name} cannot be decrypted on this device.`,
          { cause: error },
        );
      }
    },
    async removeCapability(capabilityId) {
      await migrateLegacy();
      await withFileLock(
        lockPath,
        async () => {
          const current = await readConfig();
          await writeConfig({
            schemaVersion: 2,
            credentials: Object.fromEntries(
              Object.entries(current.credentials).filter(
                ([key]) => !key.startsWith(`${capabilityId}/`),
              ),
            ),
          });
        },
        { operation: "capability-credentials.remove" },
      );
    },
    async fingerprint(capabilityId) {
      const values = Object.entries((await readConfig()).credentials)
        .filter(([key]) => key.startsWith(`${capabilityId}/`))
        .sort(([a], [b]) => a.localeCompare(b));
      return createHash("sha256").update(JSON.stringify(values)).digest("hex");
    },
  };
}

function version(value: unknown): number {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isInteger((value as { schemaVersion?: unknown }).schemaVersion)
  )
    throw new Error("Invalid credential schema version.");
  return (value as { schemaVersion: number }).schemaVersion;
}
function parseLegacy(value: unknown): LegacyStoredCredentialConfig {
  return CapabilityCredentialsV1Schema.parse(value);
}
function parseCurrent(value: unknown): StoredCredentialConfig {
  if (version(value) !== 2 || !recordOf((value as { credentials?: unknown }).credentials, isRef))
    throw new Error("Invalid current capability credentials.");
  return value as StoredCredentialConfig;
}
function recordOf(
  value: unknown,
  valid: (entry: unknown) => boolean,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(valid)
  );
}
function isRef(value: unknown): value is SecretRef {
  return SecretRefSchema.safeParse(value).success;
}
function splitKey(key: string): [string, string] {
  const index = key.indexOf("/");
  if (index <= 0 || index === key.length - 1)
    throw new Error("Invalid legacy capability credential key.");
  return [key.slice(0, index), key.slice(index + 1)];
}
