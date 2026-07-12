import { z } from "zod";
import { RuntimeSessionRefSchema } from "@pragma/core";

import type {
  ExperienceMemoryRecord,
  FactMemoryRecord,
  MemoryEvidenceRecord,
  MemoryRecordSchemaVersion,
  SkillMemoryRecord,
  TaskMemoryRecord,
} from "./types.ts";

export const TASK_MEMORY_SCHEMA_VERSION = "pragma.memory-task/v2" as const;
export const EXPERIENCE_MEMORY_SCHEMA_VERSION = "pragma.memory-experience/v2" as const;
export const FACT_MEMORY_SCHEMA_VERSION = "pragma.memory-fact/v1" as const;
export const SKILL_MEMORY_SCHEMA_VERSION = "pragma.memory-skill/v1" as const;
export const MEMORY_EVIDENCE_SCHEMA_VERSION = "pragma.memory-evidence/v2" as const;

const MemoryTypeSchema = z.enum(["task", "experience", "fact", "skill"]);
const MemoryScopeSchema = z.enum(["run", "session", "agent", "workspace", "organization"]);
const MemoryVisibilitySchema = z.enum(["shared", "private"]);
const MemoryConfidenceSchema = z.enum(["low", "medium", "high", "verified"]);

const MemoryReferenceSchema = z.object({
  type: MemoryTypeSchema,
  id: z.string().min(1),
});

const MemoryEvidenceReferenceSchema = z
  .object({
    type: z.enum([
      "context",
      "event",
      "message",
      "run",
      "execution",
      "task",
      "tool",
      "memory",
      "external",
    ]),
    id: z.string().min(1),
    label: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    memory: MemoryReferenceSchema.optional(),
  })
  .passthrough();

const MemoryProvenanceSchema = z
  .object({
    createdBy: z.string().min(1).optional(),
    updatedBy: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    evidence: z.array(MemoryEvidenceReferenceSchema),
  })
  .passthrough();

const MemoryRuntimeControlSchema = z
  .object({
    trigger: z.enum(["always_on", "model_decision", "manual"]),
    priority: z.number().optional(),
    maxBytes: z.number().int().positive().optional(),
  })
  .passthrough();

const BaseMemoryRecordSchema = z
  .object({
    id: z.string().min(1),
    type: MemoryTypeSchema,
    scope: MemoryScopeSchema,
    title: z.string().min(1).optional(),
    summary: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    runtime: MemoryRuntimeControlSchema.optional(),
    provenance: MemoryProvenanceSchema,
  })
  .passthrough();

const TaskTodoItemSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    done: z.boolean(),
    assigneeAgentId: z.string().min(1).optional(),
  })
  .passthrough();

export const TaskMemoryRecordSchema = BaseMemoryRecordSchema.extend({
  schemaVersion: z.literal(TASK_MEMORY_SCHEMA_VERSION).default(TASK_MEMORY_SCHEMA_VERSION),
  type: z.literal("task"),
  scope: z.enum(["run", "session"]),
  visibility: MemoryVisibilitySchema,
  ownerAgentId: z.string().min(1).optional(),
  executionId: z.string().min(1),
  invocationId: z.string().min(1).optional(),
  runtimeSession: RuntimeSessionRefSchema.optional(),
  kind: z.enum(["decision", "handoff", "note", "todo", "progress", "question"]),
  content: z.string(),
  items: z.array(TaskTodoItemSchema).optional(),
  status: z.enum(["active", "resolved", "archived"]),
  revision: z.number().int().nonnegative(),
}).passthrough() satisfies z.ZodType<TaskMemoryRecord>;

export const ExperienceMemoryRecordSchema = BaseMemoryRecordSchema.extend({
  schemaVersion: z
    .literal(EXPERIENCE_MEMORY_SCHEMA_VERSION)
    .default(EXPERIENCE_MEMORY_SCHEMA_VERSION),
  type: z.literal("experience"),
  kind: z.enum(["conversation", "recovery", "run", "execution", "tool"]),
  content: z.string(),
  executionId: z.string().min(1).optional(),
  invocationId: z.string().min(1).optional(),
  runtimeSession: RuntimeSessionRefSchema.optional(),
  status: z.enum(["recorded", "summarized", "promoted"]),
}).passthrough() satisfies z.ZodType<ExperienceMemoryRecord>;

export const FactMemoryRecordSchema = BaseMemoryRecordSchema.extend({
  schemaVersion: z.literal(FACT_MEMORY_SCHEMA_VERSION).default(FACT_MEMORY_SCHEMA_VERSION),
  type: z.literal("fact"),
  statement: z.string().min(1),
  confidence: MemoryConfidenceSchema,
  observedAt: z.string().min(1),
  verifiedAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  reviewAt: z.string().min(1).optional(),
  invalidatedAt: z.string().min(1).optional(),
  supersededBy: MemoryReferenceSchema.optional(),
  conflictsWith: z.array(MemoryReferenceSchema).optional(),
}).passthrough() satisfies z.ZodType<FactMemoryRecord>;

export const SkillMemoryRecordSchema = BaseMemoryRecordSchema.extend({
  schemaVersion: z.literal(SKILL_MEMORY_SCHEMA_VERSION).default(SKILL_MEMORY_SCHEMA_VERSION),
  type: z.literal("skill"),
  problemClass: z.string().min(1),
  recommendedApproach: z.array(z.string()),
  goodPractices: z.array(z.string()),
  antiPatterns: z.array(z.string()),
  failureModes: z.array(z.string()),
  recoveryPlaybook: z.array(z.string()),
  confidence: MemoryConfidenceSchema.optional(),
}).passthrough() satisfies z.ZodType<SkillMemoryRecord>;

const MemoryRunEvidencePayloadSchema = z
  .object({
    query: z.string().min(1),
    status: z.enum(["succeeded", "failed", "cancelled", "running"]),
    outputExcerpt: z.string().optional(),
    errorMessage: z.string().optional(),
    lessons: z.array(z.string()).default([]),
    tools: z
      .array(
        z
          .object({
            toolName: z.string().min(1),
            status: z.enum(["started", "completed", "failed"]),
            outputExcerpt: z.string().optional(),
            errorMessage: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const MemoryExecutionEvidencePayloadSchema = z
  .object({
    executionId: z.string().min(1),
    runtimeSessions: z.array(RuntimeSessionRefSchema).default([]),
    runIds: z.array(z.string().min(1)).default([]),
    externalContext: z.boolean().default(false),
    runs: z.array(MemoryRunEvidencePayloadSchema).default([]),
  })
  .passthrough();

const MemoryTaskArchiveEvidencePayloadSchema = z
  .object({
    task: TaskMemoryRecordSchema,
  })
  .passthrough();

export const MemoryEvidenceRecordSchema = z
  .object({
    schemaVersion: z
      .literal(MEMORY_EVIDENCE_SCHEMA_VERSION)
      .default(MEMORY_EVIDENCE_SCHEMA_VERSION),
    id: z.string().min(1),
    type: z.literal("evidence"),
    kind: z.enum(["task_archive", "run", "execution"]),
    agentId: z.string().min(1),
    scope: MemoryScopeSchema,
    executionId: z.string().min(1).optional(),
    invocationId: z.string().min(1).optional(),
    runtimeSession: RuntimeSessionRefSchema.optional(),
    payload: z.union([
      MemoryTaskArchiveEvidencePayloadSchema,
      MemoryRunEvidencePayloadSchema,
      MemoryExecutionEvidencePayloadSchema,
    ]),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    provenance: MemoryProvenanceSchema,
  })
  .passthrough() satisfies z.ZodType<MemoryEvidenceRecord>;

export function parseTaskMemoryRecord(input: unknown): TaskMemoryRecord {
  return TaskMemoryRecordSchema.parse(addMissingSchemaVersion(input, TASK_MEMORY_SCHEMA_VERSION));
}

export function parseTaskMemoryRecords(input: unknown): readonly TaskMemoryRecord[] {
  return z.array(z.unknown()).parse(input).map(parseTaskMemoryRecord);
}

export function parseExperienceMemoryRecord(input: unknown): ExperienceMemoryRecord {
  return ExperienceMemoryRecordSchema.parse(
    addMissingSchemaVersion(input, EXPERIENCE_MEMORY_SCHEMA_VERSION),
  );
}

export function parseExperienceMemoryRecords(input: unknown): readonly ExperienceMemoryRecord[] {
  return z.array(z.unknown()).parse(input).map(parseExperienceMemoryRecord);
}

export function parseFactMemoryRecord(input: unknown): FactMemoryRecord {
  return FactMemoryRecordSchema.parse(addMissingSchemaVersion(input, FACT_MEMORY_SCHEMA_VERSION));
}

export function parseFactMemoryRecords(input: unknown): readonly FactMemoryRecord[] {
  return z.array(z.unknown()).parse(input).map(parseFactMemoryRecord);
}

export function parseSkillMemoryRecord(input: unknown): SkillMemoryRecord {
  return SkillMemoryRecordSchema.parse(addMissingSchemaVersion(input, SKILL_MEMORY_SCHEMA_VERSION));
}

export function parseMemoryEvidenceRecord(input: unknown): MemoryEvidenceRecord {
  return MemoryEvidenceRecordSchema.parse(
    addMissingSchemaVersion(input, MEMORY_EVIDENCE_SCHEMA_VERSION),
  );
}

function addMissingSchemaVersion<
  TSchemaVersion extends MemoryRecordSchemaVersion | typeof MEMORY_EVIDENCE_SCHEMA_VERSION,
>(input: unknown, schemaVersion: TSchemaVersion): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  if ("schemaVersion" in input) {
    return input;
  }

  return {
    schemaVersion,
    ...input,
  };
}
