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

const DEFAULT_SETTINGS: DesktopSettings = {
  schemaVersion: 1,
  localePreference: "system",
};

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
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): DesktopSettingsStore {
  const lockPath = `${options.settingsPath}.lock`;

  const readSettings = async (): Promise<DesktopSettings> => {
    try {
      return DesktopSettingsSchema.parse(JSON.parse(await readFile(options.settingsPath, "utf8")));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return DEFAULT_SETTINGS;
      options.warn?.("Desktop settings could not be read; following the system language.", error);
      return DEFAULT_SETTINGS;
    }
  };

  const toSnapshot = (
    settings: DesktopSettings,
    preferredSystemLanguages: readonly string[],
  ): DesktopSettingsSnapshot => ({
    ...settings,
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
      const settings = DesktopSettingsSchema.parse({
        schemaVersion: 1,
        localePreference: input.localePreference,
      });
      await withFileLock(lockPath, async () => {
        await mkdir(dirname(options.settingsPath), { recursive: true, mode: 0o700 });
        await chmod(dirname(options.settingsPath), 0o700).catch(() => undefined);
        const temporaryPath = `${options.settingsPath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
        await rename(temporaryPath, options.settingsPath);
        await chmod(options.settingsPath, 0o600).catch(() => undefined);
      });
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
