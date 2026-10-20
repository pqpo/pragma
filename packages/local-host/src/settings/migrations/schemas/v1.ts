import { ToolPermissionModeSchema } from "@pragma/shared";
import { z } from "zod";

/** Historical persisted Desktop Settings shape. */
export const DesktopSettingsV1Schema = z.object({
  schemaVersion: z.literal(1),
  localePreference: z.enum(["system", "en", "zh-Hans", "zh-Hant"]),
  toolPermissionMode: ToolPermissionModeSchema.default("request-approval"),
  defaultWorkspace: z.string().trim().min(1).max(2_000).optional(),
});

export type DesktopSettingsV1 = z.infer<typeof DesktopSettingsV1Schema>;
