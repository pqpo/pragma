import { z } from "zod";
import { MemoryExtractionToolSchemas, MemoryExtractionTypeSchema } from "./schema.ts";

const legacy = MemoryExtractionToolSchemas;
export const MemoryExtractionV2ToolSchemas = {
  list_evidence: legacy.list_evidence,
  read_evidence: legacy.read_evidence,
  find_existing_memory: z
    .object({
      query: z.string().trim().min(1).max(200),
      mode: legacy.find_existing_memory.shape.mode,
      type: legacy.find_existing_memory.shape.type,
      limit: legacy.find_existing_memory.shape.limit,
    })
    .strict(),
  read_existing_memory: z
    .object({
      memory: z.string().min(1),
      cursor: z.number().int().nonnegative().default(0),
    })
    .strict(),
  list_existing_memory: legacy.list_existing_memory,
  get_extraction_status: z
    .object({ candidateOffset: z.number().int().nonnegative().default(0) })
    .strict(),
  read_staged_candidate: z
    .object({
      candidate: z.string().min(1),
      cursor: z.number().int().nonnegative().default(0),
    })
    .strict(),
  submit_fact: z
    .object({ ...legacy.submit_fact.shape })
    .omit({ property: true })
    .extend({
      predicate: legacy.submit_fact.shape.predicate.unwrap(),
      conflictMode: legacy.submit_fact.shape.conflictMode.unwrap(),
    })
    .strict(),
  submit_episode_part: legacy.submit_episode_part,
  finish_semantic_extraction: z.object({}).strict(),
  finish_episodic_extraction: z
    .object({
      language: z.string().min(2).max(32),
      valueScore: z.number().min(0).max(1),
    })
    .strict(),
  skip_extraction: z
    .object({
      type: MemoryExtractionTypeSchema,
      reason: z.enum(["no-supported-memory", "insufficient-evidence", "sensitive"]),
    })
    .strict(),
} as const;
export type MemoryExtractionV2ToolName = keyof typeof MemoryExtractionV2ToolSchemas;
export const MemoryExtractionProgressSchema = z
  .object({
    requestedTypes: z.array(MemoryExtractionTypeSchema),
    completedTypes: z.array(MemoryExtractionTypeSchema),
    unreadRecords: z.number().int().nonnegative(),
    stagedFacts: z.number().int().nonnegative(),
    stagedEpisodeParts: z.number().int().nonnegative(),
    missingEpisodeParts: z.array(z.enum(["goal", "summary", "outcome"])),
    remainingCalls: z.number().int().nonnegative(),
    remainingTokens: z.number().int().nonnegative(),
  })
  .strict();
export const MemoryExtractionFeedbackSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-curator-tool-result/v2"),
    status: z.enum(["ok", "needs_correction", "blocked"]),
    code: z.string().optional(),
    progress: MemoryExtractionProgressSchema.optional(),
    candidate: z.string().optional(),
    requiredFields: z.array(z.string()).optional(),
    example: z.record(z.string(), z.unknown()).optional(),
    nextCall: z
      .object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })
      .strict()
      .optional(),
  })
  .strict();
export type MemoryExtractionFeedback = z.infer<typeof MemoryExtractionFeedbackSchema>;
export type MemoryExtractionFeedbackInput = Pick<
  MemoryExtractionFeedback,
  "status" | "code" | "requiredFields" | "example" | "nextCall"
>;

export const EPISODE_PART_EXAMPLES = Object.freeze({
  goal: { part: "goal", text: "<evidence-supported goal>", evidence: ["e1"] },
  summary: { part: "summary", text: "<evidence-supported summary>", evidence: ["e1"] },
  attempt: {
    part: "attempt",
    description: "<attempt>",
    result: "<observed result>",
    evidence: ["e1"],
  },
  recovery: {
    part: "recovery",
    failure: "<observed failure>",
    recovery: "<recovery action>",
    evidence: ["e1"],
  },
  outcome: {
    part: "outcome",
    status: "succeeded",
    summary: "<observed outcome>",
    evidence: ["e1"],
  },
});
