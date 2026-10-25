import { ToolPermissionModeSchema } from "@pragma/shared";
import { z } from "zod";

export const DesktopLocalePreferenceSchema = z.enum(["system", "en", "zh-Hans", "zh-Hant"]);

export const DesktopResolvedLocaleSchema = z.enum(["en", "zh-Hans", "zh-Hant"]);

/** Historical migration compatibility; current settings do not select a permission mode. */
export const DesktopToolPermissionModeSchema = ToolPermissionModeSchema;

export const DesktopSettingsSchema = z.object({
  schemaVersion: z.literal(3),
  localePreference: DesktopLocalePreferenceSchema,
  defaultWorkspace: z.string().trim().min(1).max(2_000).optional(),
  agentContextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const UpdateDesktopSettingsSchema = z
  .object({
    localePreference: DesktopLocalePreferenceSchema.optional(),
    defaultWorkspace: z.string().trim().min(1).max(2_000).nullable().optional(),
    agentContextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine(
    (input) =>
      input.localePreference !== undefined ||
      input.defaultWorkspace !== undefined ||
      input.agentContextWindow !== undefined,
    "At least one Desktop setting must be provided.",
  );

export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export type UpdateDesktopSettings = z.infer<typeof UpdateDesktopSettingsSchema>;
