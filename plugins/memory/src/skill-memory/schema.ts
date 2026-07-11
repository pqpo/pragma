import { z } from "zod";
import { RuntimeSessionRefSchema } from "@pragma/core";

export const SkillMemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  useMemories: z.boolean().default(true),
  generateMemories: z.boolean().default(true),
  disableOnExternalContext: z.boolean().default(true),
  minRunOutputChars: z.number().int().nonnegative().default(0),
  summaryMaxBytes: z.number().int().positive().default(8192),
  maxOutputExcerptChars: z.number().int().positive().default(1200),
  maxToolExcerptChars: z.number().int().positive().default(400),
  memoryRoot: z.string().min(1).default("."),
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
    schemaVersion: z
      .literal("pragma.memory-run-evidence/v2")
      .default("pragma.memory-run-evidence/v2"),
    agentId: z.string().min(1),
    workflowRunId: z.string().min(1),
    runtimeSession: RuntimeSessionRefSchema.optional(),
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
        runtimeSession: RuntimeSessionRefSchema.optional(),
      })
      .default({}),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    audit: MemoryAuditSchema.default({ createdBy: "skill-memory" }),
  })
  .passthrough();

export const MemoryWorkflowEvidenceSchema = z
  .object({
    schemaVersion: z
      .literal("pragma.memory-workflow-evidence/v2")
      .default("pragma.memory-workflow-evidence/v2"),
    agentId: z.string().min(1),
    workflowRunId: z.string().min(1),
    runtimeSessions: z.array(RuntimeSessionRefSchema).default([]),
    runIds: z.array(z.string().min(1)).default([]),
    externalContext: z.boolean().default(false),
    consolidationState: z.enum(["pending", "summarized", "skills_updated"]).default("pending"),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    audit: MemoryAuditSchema.default({ createdBy: "skill-memory" }),
  })
  .passthrough();

export type MemoryRunEvidence = z.infer<typeof MemoryRunEvidenceSchema>;
export type MemoryWorkflowEvidence = z.infer<typeof MemoryWorkflowEvidenceSchema>;

export function parseSkillMemoryConfig(input: SkillMemoryConfigInput = {}): SkillMemoryConfig {
  return SkillMemoryConfigSchema.parse(input);
}
