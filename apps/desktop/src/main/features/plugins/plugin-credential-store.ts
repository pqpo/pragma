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
import { PluginCredentialsV1Schema, pluginCredentialsV1ToV2Step } from "./migrations/index.ts";

interface LegacyPluginCredentials {
  readonly schemaVersion: 1;
  readonly credentials: Readonly<Record<string, string>>;
}
interface StoredPluginCredentials {
  readonly schemaVersion: 2;
  readonly credentials: Readonly<Record<string, SecretRef>>;
}
export interface PluginCredentialStore {
  applyChanges(changes: PluginCredentialChanges): Promise<void>;
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | undefined>;
  has(ref: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  fingerprint(refs: readonly string[]): Promise<string>;
  migrateLegacy?(): Promise<boolean>;
}
export interface PluginCredentialChanges {
  readonly set?: Readonly<Record<string, string>> | undefined;
  readonly remove?: readonly string[] | undefined;
}
export class PluginCredentialStoreError extends Error {
  constructor(
    readonly code: "migration_required" | "secret_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginCredentialStoreError";
  }
}

export function createPluginCredentialStore(options: {
  readonly configPath: string;
  readonly secretStore: SecretStore;
  readonly legacyDecryptor?: LegacyCredentialDecryptor | undefined;
}): PluginCredentialStore {
  const lockPath = `${options.configPath}.lock`;
  const migrateLegacy = async (): Promise<boolean> =>
    (
      await migrateLegacyCredentialAggregate<LegacyPluginCredentials, StoredPluginCredentials>({
        configPath: options.configPath,
        family: "pragma.plugin-credentials",
        sourceVersion: pluginCredentialsV1ToV2Step.fromVersion,
        targetVersion: pluginCredentialsV1ToV2Step.toVersion,
        secretStore: options.secretStore,
        decryptor: options.legacyDecryptor,
        parseLegacy,
        parseCurrent,
        collect: (legacy) =>
          Object.entries(legacy.credentials).map(
            ([key, ciphertext]) =>
              ({
                key,
                ciphertext,
                owner: { kind: "plugin-binding", bindingRef: key },
              }) satisfies LegacySecretRecord,
          ),
        target: (legacy, refs) => ({
          schemaVersion: 2,
          credentials: Object.fromEntries(
            Object.keys(legacy.credentials).map((key) => [key, refs.get(key)!]),
          ),
        }),
      })
    ).migrated;
  const read = async (): Promise<StoredPluginCredentials> => {
    try {
      const raw = JSON.parse(await readFile(options.configPath, "utf8")) as unknown;
      if (version(raw) === 1) {
        if (!options.legacyDecryptor)
          throw new PluginCredentialStoreError(
            "migration_required",
            "Open the upgraded Desktop to migrate plugin credentials.",
          );
        await migrateLegacy();
        return await read();
      }
      return parseCurrent(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 2, credentials: {} };
      if (error instanceof PluginCredentialStoreError) throw error;
      throw error;
    }
  };
  const write = async (value: StoredPluginCredentials): Promise<void> => {
    const { mkdir, chmod, rename, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.configPath), 0o700).catch(() => undefined);
    const temporary = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, options.configPath);
    await chmod(options.configPath, 0o600).catch(() => undefined);
  };
  const applyChanges = async (changes: PluginCredentialChanges): Promise<void> => {
    const set = changes.set ?? {};
    const remove = new Set(changes.remove ?? []);
    for (const ref of Object.keys(set))
      if (remove.has(ref))
        throw new Error(`Plugin credential change both sets and removes binding: ${ref}.`);
    if (Object.keys(set).length === 0 && remove.size === 0) return;
    await migrateLegacy();
    await withFileLock(
      lockPath,
      async () => {
        const current = await read();
        const credentials = Object.fromEntries(
          Object.entries(current.credentials).filter(([ref]) => !remove.has(ref)),
        ) as Record<string, SecretRef>;
        for (const [ref, value] of Object.entries(set)) {
          const existing = credentials[ref];
          credentials[ref] = await options.secretStore.put({
            owner: { kind: "plugin-binding", bindingRef: ref },
            value: Buffer.from(value),
            ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
          });
        }
        await write({ schemaVersion: 2, credentials });
      },
      { operation: "plugin-credentials.mutate" },
    );
  };
  return {
    migrateLegacy,
    applyChanges,
    async set(ref, value) {
      await applyChanges({ set: { [ref]: value } });
    },
    async get(ref) {
      const value = (await read()).credentials[ref];
      if (!value) return undefined;
      try {
        const handle = await options.secretStore.get(value);
        try {
          return handle.utf8();
        } finally {
          handle.dispose();
        }
      } catch (error) {
        if (
          error instanceof SecretStoreError &&
          (error.code === "SECRET_STORE_LOCKED" || error.code === "KEYCHAIN_UNAVAILABLE")
        )
          throw error;
        throw new PluginCredentialStoreError(
          "secret_unavailable",
          "The saved plugin credential cannot be decrypted on this device.",
          { cause: error },
        );
      }
    },
    async has(ref) {
      return (await read()).credentials[ref] !== undefined;
    },
    async remove(ref) {
      await applyChanges({ remove: [ref] });
    },
    async removePrefix(prefix) {
      const current = await read();
      await applyChanges({
        remove: Object.keys(current.credentials).filter((key) => key.startsWith(prefix)),
      });
    },
    async fingerprint(refs) {
      const current = await read();
      return createHash("sha256")
        .update(
          JSON.stringify(refs.toSorted().map((ref) => [ref, current.credentials[ref] ?? null])),
        )
        .digest("hex");
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
function parseLegacy(value: unknown): LegacyPluginCredentials {
  return PluginCredentialsV1Schema.parse(value);
}
function parseCurrent(value: unknown): StoredPluginCredentials {
  if (version(value) !== 2 || !recordOf((value as { credentials?: unknown }).credentials, isRef))
    throw new Error("Invalid current plugin credentials.");
  return value as StoredPluginCredentials;
}
function recordOf(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(predicate)
  );
}
function isRef(value: unknown): value is SecretRef {
  return SecretRefSchema.safeParse(value).success;
}
