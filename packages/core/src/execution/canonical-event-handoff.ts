import { z } from "zod";

import { CanonicalEventEnvelopeSchema } from "@pragma/shared";

import { ExecutionCommitJournalSchema } from "../storage/migrations/execution-transaction/index.ts";

export const CanonicalEventHandoffSchema = z.object({
  schemaVersion: z.literal("pragma.canonical-event-handoff/v1"),
  executionId: z.string().min(1),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  createdAt: z.string().datetime(),
  transaction: ExecutionCommitJournalSchema,
  events: z.array(CanonicalEventEnvelopeSchema),
});

export type CanonicalEventHandoff = z.infer<typeof CanonicalEventHandoffSchema>;
