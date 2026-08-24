import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";
import type { IntegrationErrorCode } from "@pragma/shared/integration";

import { createNativeOsKeychain } from "./native-os-keychain.ts";
import type { SecretStore } from "./secret-store.ts";
import { createSecretStore, type OsKeychain } from "./secret-store.ts";

export type CredentialDoctorFinding = {
  readonly module: "model-provider" | "capability" | "plugin";
  readonly status: "ready" | "migration_required" | "degraded";
  readonly code?: IntegrationErrorCode | undefined;
};

/** Metadata-only inspection suitable for a CLI doctor presenter. It never reads an envelope value. */
export async function inspectCredentialMigration(input: {
  readonly secretStore: SecretStore;
  readonly files: Readonly<Record<CredentialDoctorFinding["module"], string>>;
}): Promise<readonly CredentialDoctorFinding[]> {
  const health = await input.secretStore.inspect();
  const keychainCode =
    health.status === "locked"
      ? "SECRET_STORE_LOCKED"
      : health.status === "unavailable"
        ? "KEYCHAIN_UNAVAILABLE"
        : undefined;
  return await Promise.all(
    (Object.entries(input.files) as [CredentialDoctorFinding["module"], string][]).map(
      async ([module, file]) => {
        if (keychainCode !== undefined) return { module, status: "degraded", code: keychainCode };
        if (await exists(`${file}.migration-journal.json`))
          return { module, status: "degraded", code: "SECRET_MIGRATION_REQUIRED" };
        let version: number | undefined;
        try {
          version = await schemaVersion(file);
        } catch (error) {
          return { module, status: "degraded", code: (error as CredentialDoctorError).code };
        }
        if (version === undefined) return { module, status: "ready" };
        const targetVersion = module === "model-provider" ? 5 : 2;
        if (version < targetVersion)
          return { module, status: "migration_required", code: "SECRET_MIGRATION_REQUIRED" };
        if (version > targetVersion)
          return { module, status: "degraded", code: "STORAGE_VERSION_UNSUPPORTED" };
        return { module, status: "ready" };
      },
    ),
  );
}

/**
 * Builds the metadata-only credential diagnostic used by Node Hosts. The caller
 * may inject a keychain for a test composition; production callers use the
 * native macOS/Windows backend and never receive a secret value.
 */
export async function inspectDefaultCredentialMigration(
  input: {
    readonly pragmaHome?: string | undefined;
    readonly keychain?: OsKeychain | undefined;
  } = {},
): Promise<readonly CredentialDoctorFinding[]> {
  const paths = new PragmaPaths({ pragmaHome: input.pragmaHome });
  return await inspectCredentialMigration({
    secretStore: createSecretStore({
      root: paths.secretStoreRoot(),
      dataRoot: paths.dataRoot(),
      keychain: input.keychain ?? createNativeOsKeychain(),
    }),
    files: {
      "model-provider": join(paths.dataRoot(), "model-providers.json"),
      capability: join(paths.credentialsRoot(), "capability-credentials.json"),
      plugin: join(paths.credentialsRoot(), "plugin-credentials.json"),
    },
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
class CredentialDoctorError extends Error {
  constructor(
    readonly code: Extract<IntegrationErrorCode, "STORAGE_CORRUPTED" | "PERMISSION_DENIED">,
  ) {
    super(code);
  }
}
async function schemaVersion(path: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EPERM") throw new CredentialDoctorError("PERMISSION_DENIED");
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger((value as { schemaVersion?: unknown }).schemaVersion)
  ) {
    throw new CredentialDoctorError("STORAGE_CORRUPTED");
  }
  return (value as { schemaVersion: number }).schemaVersion;
}
