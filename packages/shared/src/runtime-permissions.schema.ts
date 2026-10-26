import { z } from "zod";

export const RuntimePermissionModeSchema = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().min(1),
  description: z.string().min(1),
  available: z.boolean(),
  // Omission preserves confirmation for default managed MCP calls.
  defaultMcpApproval: z.enum(["none", "ask"]).optional(),
  reason: z.string().optional(),
});
export const RuntimePermissionCatalogSchema = z.object({
  defaultModeId: z.string().min(1),
  modes: z.array(RuntimePermissionModeSchema).min(1),
});
export type RuntimePermissionCatalog = z.infer<typeof RuntimePermissionCatalogSchema>;
