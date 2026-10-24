import { DesktopSettingsV2Schema, desktopSettingsV2ToV3Step } from "./migrations/index.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { applyAtomicStateMigration, recoverAtomicStateMigration, withFileLock } from "@pragma/core";
import { DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS } from "@pragma/shared";

import {
  DesktopSettingsSchema,
  type DesktopSettings,
  type UpdateDesktopSettings,
} from "../deployment-contracts/settings.ts";
import { DesktopSettingsV1Schema, desktopSettingsV1ToV2Step } from "./migrations/index.ts";

const CONFIG_SCHEMA_VERSION = 3;
const DESKTOP_SETTINGS_MIGRATION_FAMILY = "pragma.desktop-settings";
const DESKTOP_SETTINGS_MIGRATION_RESOURCE_ID = "desktop-settings";

export interface LocalHostSettingsStore {
  get(): Promise<DesktopSettings>;
  update(input: UpdateDesktopSettings): Promise<DesktopSettings>;
}

export const DESKTOP_SETTINGS_MIGRATION_ERROR_CODES = {
  recoveryFailed: "desktop_settings_migration_recovery_failed",
  migrationFailed: "desktop_settings_migration_failed",
  unsupportedVersion: "desktop_settings_unsupported_version",
  invalidSettings: "desktop_settings_invalid",
} as const;

export class DesktopSettingsMigrationError extends Error {
  constructor(
    readonly code: (typeof DESKTOP_SETTINGS_MIGRATION_ERROR_CODES)[keyof typeof DESKTOP_SETTINGS_MIGRATION_ERROR_CODES],
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "DesktopSettingsMigrationError";
  }
}

export function createLocalHostSettingsStore(options: {
  readonly settingsPath: string;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): LocalHostSettingsStore {
  const lockPath = `${options.settingsPath}.lock`;
  const settingsDirectory = dirname(options.settingsPath);
  const settingsFileName = basename(options.settingsPath);
  const migrationJournalPath = join(settingsDirectory, "desktop-settings.migration.json");
  const defaultSettings: DesktopSettings = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    localePreference: "system",
    agentContextWindow: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  };

  const validateMigrationDocuments = (documents: Readonly<Record<string, unknown>>) => {
    if (Object.keys(documents).length !== 1 || !(settingsFileName in documents)) {
      throw new Error("Desktop settings migration must contain exactly one settings document.");
    }
    const value = documents[settingsFileName];
    if (readSchemaVersion(value) === 2) DesktopSettingsV2Schema.parse(value);
    else DesktopSettingsSchema.parse(value);
  };

  const recoverMigration = async (): Promise<void> => {
    try {
      await recoverAtomicStateMigration({
        aggregateRoot: settingsDirectory,
        journalFile: migrationJournalPath,
        resource: {
          family: DESKTOP_SETTINGS_MIGRATION_FAMILY,
          id: DESKTOP_SETTINGS_MIGRATION_RESOURCE_ID,
        },
        validateDocuments: validateMigrationDocuments,
      });
    } catch (error) {
      throw new DesktopSettingsMigrationError(
        DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.recoveryFailed,
        { cause: error },
      );
    }
  };

  const migrateToCurrent = async (source: unknown): Promise<void> => {
    let target: DesktopSettings;
    try {
      target = DesktopSettingsSchema.parse(
        desktopSettingsV2ToV3Step.migrate(
          readSchemaVersion(source) === 1
            ? desktopSettingsV1ToV2Step.migrate(DesktopSettingsV1Schema.parse(source))
            : source,
        ),
      );
    } catch (error) {
      throw new DesktopSettingsMigrationError(
        DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.migrationFailed,
        { cause: error },
      );
    }
    try {
      const backupRoot = join(settingsDirectory, "migrations", "backups");
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      const sourceHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
      await copyFile(
        options.settingsPath,
        join(backupRoot, `${sourceHash}.desktop-settings.v${readSchemaVersion(source)}.json`),
      );
      await applyAtomicStateMigration({
        aggregateRoot: settingsDirectory,
        journalFile: migrationJournalPath,
        resource: {
          family: DESKTOP_SETTINGS_MIGRATION_FAMILY,
          id: DESKTOP_SETTINGS_MIGRATION_RESOURCE_ID,
        },
        fromVersion: readSchemaVersion(source)!,
        toVersion: 3,
        documents: { [settingsFileName]: target },
        validateDocuments: validateMigrationDocuments,
      });
    } catch (error) {
      throw new DesktopSettingsMigrationError(
        DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.migrationFailed,
        { cause: error },
      );
    }
  };

  const readSettingsUnlocked = async (): Promise<DesktopSettings> => {
    try {
      const persisted = await readFile(options.settingsPath, "utf8").catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      });
      if (persisted !== undefined) {
        const persistedVersion = readSchemaVersion(JSON.parse(persisted));
        if (persistedVersion === undefined)
          throw new DesktopSettingsMigrationError(
            DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
          );
        if (persistedVersion > CONFIG_SCHEMA_VERSION)
          throw new DesktopSettingsMigrationError(
            DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.unsupportedVersion,
          );
      }
      await recoverMigration();
      const source = JSON.parse(await readFile(options.settingsPath, "utf8")) as unknown;
      const version = readSchemaVersion(source);
      if (version === undefined) {
        throw new DesktopSettingsMigrationError(
          DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
        );
      }
      if (version === 1 || version === 2) {
        await migrateToCurrent(source);
        return DesktopSettingsSchema.parse(
          JSON.parse(await readFile(options.settingsPath, "utf8")),
        );
      }
      if (version !== CONFIG_SCHEMA_VERSION) {
        throw new DesktopSettingsMigrationError(
          DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.unsupportedVersion,
        );
      }
      return DesktopSettingsSchema.parse(source);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return defaultSettings;
      if (error instanceof DesktopSettingsMigrationError) throw error;
      options.warn?.("Desktop settings could not be read safely; preserving the source.", error);
      throw new DesktopSettingsMigrationError(
        DESKTOP_SETTINGS_MIGRATION_ERROR_CODES.invalidSettings,
        { cause: error },
      );
    }
  };

  const readSettings = async (): Promise<DesktopSettings> =>
    await withFileLock(lockPath, async () => await readSettingsUnlocked());

  return {
    async get() {
      return await readSettings();
    },
    async update(input) {
      let settings: DesktopSettings | undefined;
      await withFileLock(lockPath, async () => {
        const current = await readSettingsUnlocked();
        const defaultWorkspace =
          input.defaultWorkspace === null
            ? undefined
            : (input.defaultWorkspace ?? current.defaultWorkspace);
        settings = DesktopSettingsSchema.parse({
          schemaVersion: CONFIG_SCHEMA_VERSION,
          localePreference: input.localePreference ?? current.localePreference,
          agentContextWindow: input.agentContextWindow ?? current.agentContextWindow,
          ...(defaultWorkspace === undefined ? {} : { defaultWorkspace }),
        });
        await mkdir(dirname(options.settingsPath), { recursive: true, mode: 0o700 });
        await chmod(dirname(options.settingsPath), 0o700).catch(() => undefined);
        const temporaryPath = `${options.settingsPath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, options.settingsPath);
        await chmod(options.settingsPath, 0o600).catch(() => undefined);
      });
      if (settings === undefined) throw new Error("Desktop settings update did not complete.");
      return settings;
    },
  };
}

function readSchemaVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("schemaVersion" in value)) return undefined;
  const schemaVersion = value.schemaVersion;
  return typeof schemaVersion === "number" && Number.isSafeInteger(schemaVersion)
    ? schemaVersion
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
