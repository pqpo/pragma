import { z } from "zod";

export const ToolPermissionModeSchema = z.enum(["request-approval", "auto-approve", "full-access"]);

export type ToolPermissionMode = z.infer<typeof ToolPermissionModeSchema>;
