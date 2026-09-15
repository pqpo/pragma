import { MissionExecutorRefSchema, PRAGMA_TEXT_LIMITS, pragmaUnicodeLength } from "@pragma/shared";
import { z } from "zod";

import { ContextStoreIdSchema } from "./context-stores.ts";
import { MissionWorkspaceSchema } from "./mission-base.ts";

// Home projects are task presets, independent of the DSL Project revision aggregate.
export const HomeProjectIdSchema = z.string().uuid();
export const ReorderHomeProjectsSchema = z
  .array(HomeProjectIdSchema)
  .max(1_000)
  .refine((ids) => new Set(ids).size === ids.length);
export const HomeProjectInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .refine((value) => pragmaUnicodeLength(value) <= PRAGMA_TEXT_LIMITS.defaultMetadata.name),
    executorRef: MissionExecutorRefSchema,
    contextStoreIds: z
      .array(ContextStoreIdSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    workspace: MissionWorkspaceSchema,
  })
  .strict();
export const HomeProjectSchema = HomeProjectInputSchema.extend({ id: HomeProjectIdSchema });
export const SaveHomeProjectSchema = HomeProjectInputSchema.extend({
  id: HomeProjectIdSchema.optional(),
});
export type HomeProject = z.infer<typeof HomeProjectSchema>;
export type SaveHomeProject = z.infer<typeof SaveHomeProjectSchema>;
export type ReorderHomeProjects = z.infer<typeof ReorderHomeProjectsSchema>;
