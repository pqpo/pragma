import { z } from "zod";

export const DesktopTerminalIntegrationSchema = z.object({
  status: z.enum(["ready", "removed", "unavailable", "failed"]),
  commandDirectory: z.string(),
  cliVersion: z.string().optional(),
  desktopVersion: z.string(),
  error: z.string().optional(),
});
export type DesktopTerminalIntegration = z.infer<typeof DesktopTerminalIntegrationSchema>;
