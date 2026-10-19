import { createLocalHostSettingsStore } from "@pragma/local-host";
export {
  DESKTOP_SETTINGS_MIGRATION_ERROR_CODES,
  DesktopSettingsMigrationError,
} from "@pragma/local-host";
import type {
  DesktopSettings,
  DesktopSettingsSnapshot,
  UpdateDesktopSettings,
} from "../../../shared/contracts/index.ts";
import { resolveDesktopLocale } from "../../../shared/desktop-locale.ts";

export interface DesktopSettingsStore {
  getSnapshot(preferredSystemLanguages: readonly string[]): Promise<DesktopSettingsSnapshot>;
  update(
    input: UpdateDesktopSettings,
    preferredSystemLanguages: readonly string[],
  ): Promise<DesktopSettingsSnapshot>;
}

export function createDesktopSettingsStore(options: {
  readonly settingsPath: string;
  readonly builtInDefaultWorkspace: string;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
}): DesktopSettingsStore {
  const store = createLocalHostSettingsStore(options);
  const toSnapshot = (
    settings: DesktopSettings,
    languages: readonly string[],
  ): DesktopSettingsSnapshot => ({
    ...settings,
    defaultWorkspace: settings.defaultWorkspace ?? options.builtInDefaultWorkspace,
    usesBuiltInDefaultWorkspace: settings.defaultWorkspace === undefined,
    resolvedLocale:
      settings.localePreference === "system"
        ? resolveDesktopLocale(languages)
        : settings.localePreference,
  });
  return {
    getSnapshot: async (languages) => toSnapshot(await store.get(), languages),
    update: async (input, languages) => toSnapshot(await store.update(input), languages),
  };
}
