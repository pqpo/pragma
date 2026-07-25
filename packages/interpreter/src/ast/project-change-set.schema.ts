import { z } from "zod";

import { PragmaResourceRefSchema, PragmaResourceSchema } from "./pragma-dsl.schema.ts";

export const PragmaProjectChangeSetSchema = z
  .object({
    baseRevision: z.number().int().nonnegative(),
    upserts: z.array(PragmaResourceSchema).default([]),
    removals: z.array(PragmaResourceRefSchema).default([]),
    requiredUnchangedRefs: z.array(PragmaResourceRefSchema).default([]),
  })
  .strict()
  .refine((input) => input.upserts.length + input.removals.length > 0, {
    message: "A project change-set must upsert or remove at least one resource.",
  });

export type PragmaProjectChangeSet = z.infer<typeof PragmaProjectChangeSetSchema>;
export type PragmaProjectChangeSetInput = z.input<typeof PragmaProjectChangeSetSchema>;
