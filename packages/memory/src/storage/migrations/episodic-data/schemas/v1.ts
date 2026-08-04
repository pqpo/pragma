import { MemorySubjectRefSchema } from "@pragma/shared";
import { z } from "zod";

export const EpisodicMemoryRecordV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-episodic/v1"),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    bindings: z.array(MemorySubjectRefSchema).min(1).max(100),
  })
  .passthrough();
