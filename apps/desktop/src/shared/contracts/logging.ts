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
    navigationId: z.string().uuid().optional(),
    elapsedMs: z.number().nonnegative().finite().optional(),
    entryCount: z.number().int().nonnegative().optional(),
    characterCount: z.number().int().nonnegative().optional(),
    cacheHit: z.boolean().optional(),
    longTaskMs: z.number().nonnegative().finite().optional(),
  })
  .strict();
export type DesktopRendererLog = z.infer<typeof DesktopRendererLogSchema>;
