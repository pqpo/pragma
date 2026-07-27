import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "@pragma/core";

import type { CredentialEncryption } from "../../platform/security/credential-encryption.ts";

interface StoredPluginCredentials {
  readonly schemaVersion: 1;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface PluginCredentialStore {
  applyChanges(changes: PluginCredentialChanges): Promise<void>;
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | undefined>;
  has(ref: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  fingerprint(refs: readonly string[]): Promise<string>;
}

export interface PluginCredentialChanges {
  readonly set?: Readonly<Record<string, string>> | undefined;
  readonly remove?: readonly string[] | undefined;
}

export function createPluginCredentialStore(options: {
  readonly configPath: string;
  readonly encryption: CredentialEncryption;
}): PluginCredentialStore {
  const lockPath = `${options.configPath}.lock`;
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
  const applyChanges = async (changes: PluginCredentialChanges): Promise<void> => {
    const set = changes.set ?? {};
    const remove = new Set(changes.remove ?? []);
    for (const ref of Object.keys(set)) {
      if (remove.has(ref)) {
        throw new Error(`Plugin credential change both sets and removes binding: ${ref}.`);
      }
    }
    if (Object.keys(set).length === 0 && remove.size === 0) return;
    if (Object.keys(set).length > 0 && !options.encryption.isAvailable()) {
      throw new Error("Secure storage is unavailable on this device.");
    }

    await withFileLock(lockPath, async () => {
      const current = await read();
      const credentials = Object.fromEntries(
        Object.entries(current.credentials).filter(([ref]) => !remove.has(ref)),
      );
      for (const [ref, value] of Object.entries(set)) {
        credentials[ref] = options.encryption.encrypt(value).toString("base64");
      }
      await write({ schemaVersion: 1, credentials });
    });
  };

  return {
    applyChanges,
    async set(ref, value) {
      await applyChanges({ set: { [ref]: value } });
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
      await applyChanges({ remove: [ref] });
    },
    async removePrefix(prefix) {
      await withFileLock(lockPath, async () => {
        const current = await read();
        const credentials = Object.fromEntries(
          Object.entries(current.credentials).filter(([key]) => !key.startsWith(prefix)),
        );
        if (Object.keys(credentials).length === Object.keys(current.credentials).length) return;
        await write({ schemaVersion: 1, credentials });
      });
    },
    async fingerprint(refs) {
      const current = await read();
      const values = refs.toSorted().map((ref) => [ref, current.credentials[ref] ?? null] as const);
      return createHash("sha256").update(JSON.stringify(values)).digest("hex");
    },
  };
}
