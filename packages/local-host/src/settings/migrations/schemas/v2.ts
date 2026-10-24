import { z } from "zod";
export const DesktopSettingsV2Schema = z.object({
  schemaVersion: z.literal(2),
  localePreference: z.enum(["system", "en", "zh-Hans", "zh-Hant"]),
  toolPermissionMode: z
    .enum(["request-approval", "auto-approve", "full-access"])
    .default("request-approval"),
  defaultWorkspace: z.string().trim().min(1).max(2000).optional(),
  agentContextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
