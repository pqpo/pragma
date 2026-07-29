import { z } from "zod";

export const DesktopRendererLogSchema = z
  .object({
    level: z.enum(["info", "warn", "error"]),
    event: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    message: z.string().min(1).max(8_192),
    errorMessage: z.string().max(8_192).optional(),
    stack: z.string().max(32_768).optional(),
    missionId: z.string().min(1).optional(),
    executionId: z.string().min(1).optional(),
    elapsedMs: z.number().nonnegative().finite().optional(),
  })
  .strict();
export type DesktopRendererLog = z.infer<typeof DesktopRendererLogSchema>;
