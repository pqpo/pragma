import { DesktopSettingsV2Schema } from "../schemas/v2.ts";
export const desktopSettingsV2ToV3Step = {
  fromVersion: 2,
  toVersion: 3,
  migrate(input: unknown) {
    const { toolPermissionMode: _retiredMode, ...settings } = DesktopSettingsV2Schema.parse(input);
    void _retiredMode;
    return { ...settings, schemaVersion: 3 as const };
  },
} as const;
