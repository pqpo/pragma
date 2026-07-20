import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { withFileLock } from "@pragma/core";

import {
  DesktopSettingsSchema,
  type DesktopResolvedLocale,
  type DesktopSettings,
  type DesktopSettingsSnapshot,
  type UpdateDesktopSettings,
} from "../shared/desktop-api.ts";

const TRADITIONAL_CHINESE_REGIONS = new Set(["HK", "MO", "TW"]);

export interface DesktopSettingsStore {
  getSnapshot(preferredSystemLanguages: readonly string[]): Promise<DesktopSettingsSnapshot>;
  update(
    input: UpdateDesktopSettings,
    preferredSystemLanguages: readonly string[],
  ): Promise<DesktopSettingsSnapshot>;
}

export function resolveDesktopLocale(
  preferredSystemLanguages: readonly string[],
): DesktopResolvedLocale {
  for (const languageTag of preferredSystemLanguages) {
    const locale = parseLocale(languageTag);
    if (locale === undefined) continue;
    if (locale.language === "en") return "en";
    if (locale.language !== "zh") continue;
    if (locale.script === "Hant") return "zh-Hant";
    if (locale.script === "Hans") return "zh-Hans";
    if (TRADITIONAL_CHINESE_REGIONS.has(locale.region ?? "")) return "zh-Hant";
    return "zh-Hans";
  }
  return "en";
}

export function createDesktopSettingsStore(options: {
  readonly settingsPath: string;
  readonly defaultStewardWorkspace: string;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): DesktopSettingsStore {
  const lockPath = `${options.settingsPath}.lock`;
  const defaultSettings: DesktopSettings = {
    schemaVersion: 1,
    localePreference: "system",
    toolPermissionMode: "request-approval",
  };

  const readSettings = async (): Promise<DesktopSettings> => {
    try {
      return DesktopSettingsSchema.parse(JSON.parse(await readFile(options.settingsPath, "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return defaultSettings;
      options.warn?.("Desktop settings could not be read; using defaults.", error);
      return defaultSettings;
    }
  };

  const toSnapshot = (
    settings: DesktopSettings,
    preferredSystemLanguages: readonly string[],
  ): DesktopSettingsSnapshot => ({
    schemaVersion: settings.schemaVersion,
    localePreference: settings.localePreference,
    toolPermissionMode: settings.toolPermissionMode,
    stewardWorkspace: settings.stewardWorkspace ?? options.defaultStewardWorkspace,
    usesDefaultStewardWorkspace: settings.stewardWorkspace === undefined,
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
        const current = await readSettings();
        const stewardWorkspace =
          input.stewardWorkspace === null
            ? undefined
            : (input.stewardWorkspace ?? current.stewardWorkspace);
        settings = DesktopSettingsSchema.parse({
          schemaVersion: 1,
          localePreference: input.localePreference ?? current.localePreference,
          toolPermissionMode: input.toolPermissionMode ?? current.toolPermissionMode,
          ...(stewardWorkspace === undefined ? {} : { stewardWorkspace }),
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

function parseLocale(languageTag: string): Intl.Locale | undefined {
  try {
    return new Intl.Locale(languageTag.replaceAll("_", "-"));
  } catch {
    return undefined;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
