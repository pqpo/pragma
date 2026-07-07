import { z } from "zod";

export const SkillMemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  useMemories: z.boolean().default(true),
  generateMemories: z.boolean().default(true),
  disableOnExternalContext: z.boolean().default(true),
  minRunOutputChars: z.number().int().nonnegative().default(0),
  summaryMaxBytes: z.number().int().positive().default(8192),
  maxOutputExcerptChars: z.number().int().positive().default(1200),
  maxToolExcerptChars: z.number().int().positive().default(400),
  taskSummaryModel: z.string().min(1).optional(),
  sessionSummaryModel: z.string().min(1).optional(),
  skillMergeModel: z.string().min(1).optional(),
  summaryModel: z.string().min(1).optional(),
  memoryRoot: z.string().min(1).default("memory"),
});

export type SkillMemoryConfig = z.infer<typeof SkillMemoryConfigSchema>;
export type SkillMemoryConfigInput = z.input<typeof SkillMemoryConfigSchema>;

export const MemoryAuditSchema = z
  .object({
    createdBy: z.string().min(1).default("skill-memory"),
    createdFromRunId: z.string().min(1).optional(),
    updatedBy: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .passthrough();

export const MemoryToolCallEvidenceSchema = z.object({
  toolName: z.string().min(1),
  status: z.enum(["started", "completed", "failed"]),
  outputExcerpt: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const MemoryRunEvidenceSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-run-evidence/v1").default("pragma.memory-run-evidence/v1"),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    runtimeSessionId: z.string().min(1).optional(),
    runId: z.string().min(1),
    query: z.string().min(1),
    status: z.enum(["succeeded", "failed", "cancelled", "running"]).default("running"),
    outputExcerpt: z.string().optional(),
    errorMessage: z.string().optional(),
    externalContext: z.boolean().default(false),
    tools: z.array(MemoryToolCallEvidenceSchema).default([]),
    lessons: z.array(z.string().min(1)).default([]),
    source: z
      .object({
        runtimeKind: z.string().min(1).optional(),
        runtimeSessionId: z.string().min(1).optional(),
      })
      .default({}),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    audit: MemoryAuditSchema.default({ createdBy: "skill-memory" }),
  })
  .passthrough();

export const MemorySessionEvidenceSchema = z
  .object({
    schemaVersion: z
      .literal("pragma.memory-session-evidence/v1")
      .default("pragma.memory-session-evidence/v1"),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    runtimeSessionId: z.string().min(1).optional(),
    runIds: z.array(z.string().min(1)).default([]),
    externalContext: z.boolean().default(false),
    consolidationState: z
      .enum(["pending", "summarized", "skills_updated"])
      .default("pending"),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    audit: MemoryAuditSchema.default({ createdBy: "skill-memory" }),
  })
  .passthrough();

export type MemoryRunEvidence = z.infer<typeof MemoryRunEvidenceSchema>;
export type MemorySessionEvidence = z.infer<typeof MemorySessionEvidenceSchema>;

export function parseSkillMemoryConfig(
  input: SkillMemoryConfigInput = {},
): SkillMemoryConfig {
  return SkillMemoryConfigSchema.parse(input);
}
