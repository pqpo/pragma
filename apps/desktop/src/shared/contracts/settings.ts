import { ToolPermissionModeSchema } from "@pragma/shared";
import { z } from "zod";

export const DesktopLocalePreferenceSchema = z.enum(["system", "en", "zh-Hans", "zh-Hant"]);

export const DesktopResolvedLocaleSchema = z.enum(["en", "zh-Hans", "zh-Hant"]);

export const DesktopToolPermissionModeSchema = ToolPermissionModeSchema;

export const DesktopSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  localePreference: DesktopLocalePreferenceSchema,
  toolPermissionMode: DesktopToolPermissionModeSchema.default("request-approval"),
  defaultWorkspace: z.string().trim().min(1).max(2_000).optional(),
});

export const DesktopSettingsSnapshotSchema = DesktopSettingsSchema.omit({
  defaultWorkspace: true,
}).extend({
  defaultWorkspace: z.string().trim().min(1).max(2_000),
  usesBuiltInDefaultWorkspace: z.boolean(),
  resolvedLocale: DesktopResolvedLocaleSchema,
});

export const UpdateDesktopSettingsSchema = z
  .object({
    localePreference: DesktopLocalePreferenceSchema.optional(),
    toolPermissionMode: DesktopToolPermissionModeSchema.optional(),
    defaultWorkspace: z.string().trim().min(1).max(2_000).nullable().optional(),
  })
  .refine(
    (input) =>
      input.localePreference !== undefined ||
      input.toolPermissionMode !== undefined ||
      input.defaultWorkspace !== undefined,
    "At least one Desktop setting must be provided.",
  );

export const PickWorkspaceResultSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  basename: z.string().optional(),
  reason: z.enum(["cancelled", "no_window", "not_directory", "not_accessible", "error"]).optional(),
  error: z.string().optional(),
});

export const ValidateWorkspacePathSchema = z.string().min(1);

export const ValidateWorkspaceResultSchema = z.object({
  ok: z.boolean(),
  reason: z
    .enum(["not_absolute", "not_found", "not_directory", "not_readable", "not_writable", "error"])
    .optional(),
  error: z.string().optional(),
});
