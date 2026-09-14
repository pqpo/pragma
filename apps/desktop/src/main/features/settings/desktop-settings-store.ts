import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { applyAtomicStateMigration, recoverAtomicStateMigration, withFileLock } from "@pragma/core";
import { DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS } from "@pragma/shared";

import {
  DesktopSettingsSchema,
  type DesktopSettings,
  type DesktopSettingsSnapshot,
  type UpdateDesktopSettings,
} from "../../../shared/contracts/index.ts";
import { resolveDesktopLocale } from "../../../shared/desktop-locale.ts";
import { DesktopSettingsV1Schema, desktopSettingsV1ToV2Step } from "./migrations/index.ts";

const CONFIG_SCHEMA_VERSION = 2;
const DESKTOP_SETTINGS_MIGRATION_FAMILY = "pragma.desktop-settings";
const DESKTOP_SETTINGS_MIGRATION_RESOURCE_ID = "desktop-settings";

export interface DesktopSettingsStore {
  getSnapshot(preferredSystemLanguages: readonly string[]): Promise<DesktopSettingsSnapshot>;
  update(
    input: UpdateDesktopSettings,
    preferredSystemLanguages: readonly string[],
  ): Promise<DesktopSettingsSnapshot>;
}

export const DESKTOP_SETTINGS_MIGRATION_ERROR_CODES = {
  recoveryFailed: "desktop_settings_migration_recovery_failed",
  migrationFailed: "desktop_settings_migration_failed",
  unsupportedVersion: "desktop_settings_unsupported_version",
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

export function createDesktopSettingsStore(options: {
  readonly settingsPath: string;
  readonly builtInDefaultWorkspace: string;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): DesktopSettingsStore {
  const lockPath = `${options.settingsPath}.lock`;
  const settingsDirectory = dirname(options.settingsPath);
  const settingsFileName = basename(options.settingsPath);
  const migrationJournalPath = join(settingsDirectory, "desktop-settings.migration.json");
  const defaultSettings: DesktopSettings = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    localePreference: "system",
    toolPermissionMode: "request-approval",
    agentContextWindow: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  };

  const validateMigrationDocuments = (documents: Readonly<Record<string, unknown>>) => {
    if (Object.keys(documents).length !== 1 || !(settingsFileName in documents)) {
      throw new Error("Desktop settings migration must contain exactly one settings document.");
    }
    DesktopSettingsSchema.parse(documents[settingsFileName]);
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

  const migrateV1ToV2 = async (source: unknown): Promise<void> => {
    let target: DesktopSettings;
    try {
      target = DesktopSettingsSchema.parse(
        desktopSettingsV1ToV2Step.migrate(DesktopSettingsV1Schema.parse(source)),
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
        join(backupRoot, `${sourceHash}.desktop-settings.v1.json`),
      );
      await applyAtomicStateMigration({
        aggregateRoot: settingsDirectory,
        journalFile: migrationJournalPath,
        resource: {
          family: DESKTOP_SETTINGS_MIGRATION_FAMILY,
          id: DESKTOP_SETTINGS_MIGRATION_RESOURCE_ID,
        },
        fromVersion: desktopSettingsV1ToV2Step.fromVersion,
        toVersion: desktopSettingsV1ToV2Step.toVersion,
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
      await recoverMigration();
      const source = JSON.parse(await readFile(options.settingsPath, "utf8")) as unknown;
      const version = readSchemaVersion(source);
      if (version === 1) {
        await migrateV1ToV2(source);
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
      options.warn?.("Desktop settings could not be read; using defaults.", error);
      return defaultSettings;
    }
  };

  const readSettings = async (): Promise<DesktopSettings> =>
    await withFileLock(lockPath, async () => await readSettingsUnlocked());

  const toSnapshot = (
    settings: DesktopSettings,
    preferredSystemLanguages: readonly string[],
  ): DesktopSettingsSnapshot => ({
    schemaVersion: settings.schemaVersion,
    localePreference: settings.localePreference,
    toolPermissionMode: settings.toolPermissionMode,
    agentContextWindow: settings.agentContextWindow,
    defaultWorkspace: settings.defaultWorkspace ?? options.builtInDefaultWorkspace,
    usesBuiltInDefaultWorkspace: settings.defaultWorkspace === undefined,
    resolvedLocale:
      settings.localePreference === "system"
        ? resolveDesktopLocale(preferredSystemLanguages)
        : settings.localePreference,
  });

  return {
    async getSnapshot(preferredSystemLanguages) {
      return toSnapshot(await readSettings(), preferredSystemLanguages);
    },
    async update(input, preferredSystemLanguages) {
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
          toolPermissionMode: input.toolPermissionMode ?? current.toolPermissionMode,
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
      return toSnapshot(settings, preferredSystemLanguages);
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
