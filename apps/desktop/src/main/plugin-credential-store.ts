import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CapabilityCredentialEncryption } from "./capability-credential-store.ts";

interface StoredPluginCredentials {
  readonly schemaVersion: 1;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface PluginCredentialStore {
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | undefined>;
  has(ref: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  fingerprint(refs: readonly string[]): Promise<string>;
}

export function createPluginCredentialStore(options: {
  readonly configPath: string;
  readonly encryption: CapabilityCredentialEncryption;
}): PluginCredentialStore {
  const read = async (): Promise<StoredPluginCredentials> => {
    try {
      const value = JSON.parse(
        await readFile(options.configPath, "utf8"),
      ) as StoredPluginCredentials;
      if (
        value.schemaVersion !== 1 ||
        value.credentials === null ||
        typeof value.credentials !== "object" ||
        Array.isArray(value.credentials) ||
        Object.values(value.credentials).some((entry) => typeof entry !== "string")
      ) {
        throw new Error("The plugin credential store has an unsupported format.");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, credentials: {} };
      }
      throw error;
    }
  };
  const write = async (value: StoredPluginCredentials): Promise<void> => {
    if (!options.encryption.isAvailable()) {
      throw new Error("Secure storage is unavailable on this device.");
    }
    const directory = dirname(options.configPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, options.configPath);
    await chmod(options.configPath, 0o600).catch(() => undefined);
  };

  return {
    async set(ref, value) {
      if (!options.encryption.isAvailable()) {
        throw new Error("Secure storage is unavailable on this device.");
      }
      const current = await read();
      await write({
        schemaVersion: 1,
        credentials: {
          ...current.credentials,
          [ref]: options.encryption.encrypt(value).toString("base64"),
        },
      });
    },
    async get(ref) {
      const encrypted = (await read()).credentials[ref];
      if (encrypted === undefined) return undefined;
      if (!options.encryption.isAvailable()) {
        throw new Error("Secure storage is unavailable on this device.");
      }
      return options.encryption.decrypt(Buffer.from(encrypted, "base64"));
    },
    async has(ref) {
      return (await read()).credentials[ref] !== undefined;
    },
    async remove(ref) {
      const current = await read();
      await write({
        schemaVersion: 1,
        credentials: Object.fromEntries(
          Object.entries(current.credentials).filter(([key]) => key !== ref),
        ),
      });
    },
    async removePrefix(prefix) {
      const current = await read();
      await write({
        schemaVersion: 1,
        credentials: Object.fromEntries(
          Object.entries(current.credentials).filter(([key]) => !key.startsWith(prefix)),
        ),
      });
    },
    async fingerprint(refs) {
      const current = await read();
      const values = refs.toSorted().map((ref) => [ref, current.credentials[ref] ?? null] as const);
      return createHash("sha256").update(JSON.stringify(values)).digest("hex");
    },
  };
}
