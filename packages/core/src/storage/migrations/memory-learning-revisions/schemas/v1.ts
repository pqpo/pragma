import { z } from "zod";
const KnowledgeBindingSchema = z
  .object({
    expertRef: z.string(),
    storeId: z.string().uuid(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    revisionJobId: z.string().uuid().optional(),
    mounted: z.boolean(),
    revisionPending: z.boolean(),
  })
  .strict();
const SkillBindingSchema = z
  .object({
    expertRef: z.string(),
    capabilityId: z.string().min(1),
    normalizedKey: z.string(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    revisionJobId: z.string().uuid().optional(),
    mounted: z.boolean(),
    revisionPending: z.boolean(),
  })
  .strict();
export const MemoryLearningStateV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.memory-learning-revisions/v1"),
    knowledge: z.array(KnowledgeBindingSchema),
    skills: z.array(SkillBindingSchema),
  })
  .strict();
