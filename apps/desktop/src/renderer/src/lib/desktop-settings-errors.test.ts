import { describe, expect, it } from "vitest";

import { desktopSettingsErrorKey } from "./desktop-settings-errors.ts";

describe("desktopSettingsErrorKey", () => {
  it.each([
    ["desktop_settings_migration_recovery_failed", "settingsMigrationError"],
    ["desktop_settings_migration_failed", "settingsMigrationError"],
    ["desktop_settings_unsupported_version", "settingsVersionTooNew"],
    ["desktop_settings_invalid", "settingsInvalid"],
  ] as const)("recognizes %s through Electron's IPC error wrapper", (code, expected) => {
    expect(
      desktopSettingsErrorKey(
        new Error(`Error invoking remote method 'desktop-settings:get': ${code}`),
      ),
    ).toBe(expected);
  });

  it("does not expose an unrecognized backend error as a settings diagnostic", () => {
    expect(desktopSettingsErrorKey(new Error("internal-only failure"))).toBe("saveError");
  });
});
