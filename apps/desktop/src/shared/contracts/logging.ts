import { z } from "zod";

export const DesktopRendererLogSchema = z
  .object({
    level: z.enum(["warn", "error"]),
    event: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    message: z.string().min(1).max(8_192),
    errorMessage: z.string().max(8_192).optional(),
    stack: z.string().max(32_768).optional(),
  })
  .strict();
export type DesktopRendererLog = z.infer<typeof DesktopRendererLogSchema>;
