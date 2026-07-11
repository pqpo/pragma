import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StoredCredentialConfig {
  readonly schemaVersion: 1;
  readonly credentials: Readonly<Record<string, string>>;
}

export interface CapabilityCredentialEncryption {
  readonly isAvailable: () => boolean;
  readonly encrypt: (plainText: string) => Buffer;
  readonly decrypt: (encrypted: Buffer) => string;
}

export interface CapabilityCredentialStore {
  setMany(capabilityId: string, credentials: Readonly<Record<string, string>>): Promise<void>;
  get(capabilityId: string, name: string): Promise<string | undefined>;
  removeCapability(capabilityId: string): Promise<void>;
}

export class CapabilityCredentialStoreError extends Error {
  constructor(
    readonly code: "config_invalid" | "encryption_unavailable" | "secret_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CapabilityCredentialStoreError";
  }
}

export function createCapabilityCredentialStore(options: {
  readonly configPath: string;
  readonly encryption: CapabilityCredentialEncryption;
}): CapabilityCredentialStore {
  const ensureEncryption = (): void => {
    if (!options.encryption.isAvailable()) {
      throw new CapabilityCredentialStoreError(
        "encryption_unavailable",
        "Secure storage is unavailable on this device. Capability credentials cannot be saved.",
      );
    }
  };

  const readConfig = async (): Promise<StoredCredentialConfig> => {
    try {
      const value = JSON.parse(await readFile(options.configPath, "utf8")) as unknown;
      if (
        !value ||
        typeof value !== "object" ||
        (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
        !isStringRecord((value as { credentials?: unknown }).credentials)
      ) {
        throw new CapabilityCredentialStoreError(
          "config_invalid",
          "The capability credential store has an unsupported format.",
        );
      }
      return value as StoredCredentialConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, credentials: {} };
      }
      if (error instanceof SyntaxError) {
        throw new CapabilityCredentialStoreError(
          "config_invalid",
          "The capability credential store is not valid JSON.",
        );
      }
      throw error;
    }
  };

  const writeConfig = async (config: StoredCredentialConfig): Promise<void> => {
    await mkdir(dirname(options.configPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(options.configPath), 0o700).catch(() => undefined);
    const temporaryPath = `${options.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, options.configPath);
    await chmod(options.configPath, 0o600).catch(() => undefined);
  };

  return {
    async setMany(capabilityId, credentials) {
      if (Object.keys(credentials).length === 0) return;
      ensureEncryption();
      const config = await readConfig();
      const encrypted = Object.fromEntries(
        Object.entries(credentials).map(([name, value]) => [
          `${capabilityId}/${name}`,
          options.encryption.encrypt(value).toString("base64"),
        ]),
      );
      await writeConfig({ ...config, credentials: { ...config.credentials, ...encrypted } });
    },
    async get(capabilityId, name) {
      const encrypted = (await readConfig()).credentials[`${capabilityId}/${name}`];
      if (encrypted === undefined) return undefined;
      ensureEncryption();
      try {
        return options.encryption.decrypt(Buffer.from(encrypted, "base64"));
      } catch {
        throw new CapabilityCredentialStoreError(
          "secret_unavailable",
          `The saved credential ${name} cannot be decrypted on this device.`,
        );
      }
    },
    async removeCapability(capabilityId) {
      const config = await readConfig();
      await writeConfig({
        ...config,
        credentials: Object.fromEntries(
          Object.entries(config.credentials).filter(([key]) => !key.startsWith(`${capabilityId}/`)),
        ),
      });
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}
