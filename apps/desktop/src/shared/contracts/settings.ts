import { z } from "zod";
import {
  DesktopSettingsSchema,
  DesktopResolvedLocaleSchema,
} from "@pragma/local-host/deployment-contracts";
export {
  DesktopSettingsSchema,
  DesktopLocalePreferenceSchema,
  DesktopResolvedLocaleSchema,
  DesktopToolPermissionModeSchema,
  UpdateDesktopSettingsSchema,
} from "@pragma/local-host/deployment-contracts";

export const DesktopSettingsSnapshotSchema = DesktopSettingsSchema.omit({
  defaultWorkspace: true,
}).extend({
  defaultWorkspace: z.string().trim().min(1).max(2_000),
  usesBuiltInDefaultWorkspace: z.boolean(),
  resolvedLocale: DesktopResolvedLocaleSchema,
});

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
