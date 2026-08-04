import { MemorySubjectRefSchema } from "@pragma/shared";
import { z } from "zod";

import { EpisodicMemoryRecordV2Schema } from "./v2.ts";

export const EpisodicMemoryRecordV3Schema = EpisodicMemoryRecordV2Schema.omit({
  schemaVersion: true,
}).extend({
  schemaVersion: z.literal("pragma.memory-episodic/v3"),
  conversationRef: MemorySubjectRefSchema,
  sourceExecutionIds: z.array(z.string().min(1)).min(1).max(1_000),
  sourceUpdatedAt: z.string().datetime(),
});
