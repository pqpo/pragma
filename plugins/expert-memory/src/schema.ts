import { z } from "zod";

export const MemoryPluginConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    useMemories: z.boolean().default(true),
    generateMemories: z.boolean().default(true),
    disableOnExternalContext: z.boolean().default(true),
    minRunOutputChars: z.number().int().positive().default(200),
    summaryMaxBytes: z.number().int().positive().default(8192),
    memoryRoot: z.string().min(1).default(".pragma/agent/memories"),
  });

export type MemoryPluginConfig = z.infer<typeof MemoryPluginConfigSchema>;
export type MemoryPluginConfigInput = z.input<typeof MemoryPluginConfigSchema>;

export const MemoryAuditSchema = z
  .object({
    createdBy: z.string().min(1).default("expert-memory"),
    createdFromRunId: z.string().min(1).optional(),
    updatedBy: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .passthrough();

export const MemoryLedgerSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-ledger/v1").default("pragma.memory-ledger/v1"),
    agentId: z.string().min(1),
    updatedAt: z.string().min(1),
    entryCount: z.number().int().nonnegative().default(0),
    audit: MemoryAuditSchema.default({ createdBy: "expert-memory" }),
  })
  .passthrough();

export const MemoryTaskEvidenceSchema = z
  .object({
    schemaVersion: z
      .literal("pragma.memory-task-evidence/v1")
      .default("pragma.memory-task-evidence/v1"),
    agentId: z.string().min(1),
    runId: z.string().min(1),
    source: z
      .object({
        type: z.string().min(1),
        id: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    audit: MemoryAuditSchema.default({ createdBy: "expert-memory" }),
  })
  .passthrough();

export type MemoryLedger = z.infer<typeof MemoryLedgerSchema>;
export type MemoryTaskEvidence = z.infer<typeof MemoryTaskEvidenceSchema>;

export function parseMemoryPluginConfig(
  input: MemoryPluginConfigInput = {},
): MemoryPluginConfig {
  return MemoryPluginConfigSchema.parse(input);
}
