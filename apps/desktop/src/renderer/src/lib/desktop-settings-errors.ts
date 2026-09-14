import { errorMessage } from "./errors.ts";

export type DesktopSettingsErrorKey =
  "settingsInvalid" | "settingsMigrationError" | "settingsVersionTooNew" | "saveError";

/**
 * Electron preserves an IPC error's message but prefixes it with invocation
 * context. Match the stable error code within that transport-wrapped message.
 */
export function desktopSettingsErrorKey(cause: unknown): DesktopSettingsErrorKey {
  const message = errorMessage(cause);
  if (message.includes("desktop_settings_migration_recovery_failed")) {
    return "settingsMigrationError";
  }
  if (message.includes("desktop_settings_migration_failed")) {
    return "settingsMigrationError";
  }
  if (message.includes("desktop_settings_unsupported_version")) {
    return "settingsVersionTooNew";
  }
  if (message.includes("desktop_settings_invalid")) return "settingsInvalid";
  return "saveError";
}
