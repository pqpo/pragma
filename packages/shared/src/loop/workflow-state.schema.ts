import { z } from "zod";

export const LoopStateSchema = z.object({
  input: z.unknown(),
  context: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.record(z.string(), z.unknown()).default({}),
  results: z.record(z.string(), z.unknown()).default({}),
  flags: z.record(z.string(), z.boolean()).default({}),
  messages: z.array(z.unknown()).default([]),
  metrics: z.record(z.string(), z.unknown()).default({}),
  private: z.record(z.string(), z.unknown()).default({}),
});

export const LoopRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);

export const TaskRunStatusSchema = z.enum([
  "pending",
  "dispatched",
  "leased",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "dead_letter",
]);

export const SandboxRefSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
});

export const WorkflowRunRecordSchema = z.object({
  id: z.string().min(1),
  loopId: z.string().min(1),
  status: LoopRunStatusSchema,
  input: z.unknown(),
  state: LoopStateSchema,
  defaultSandbox: SandboxRefSchema,
  currentStepIds: z.array(z.string().min(1)),
  completedStepIds: z.array(z.string().min(1)),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const TaskRunRecordSchema = z.object({
  id: z.string().min(1),
  workflowRunId: z.string().min(1),
  stepId: z.string().min(1),
  visit: z.number().int().positive(),
  status: TaskRunStatusSchema,
  runtimeId: z.string().min(1),
  sandbox: SandboxRefSchema.optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  attempt: z.number().int().positive(),
  leaseOwner: z.string().min(1).optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type LoopState = z.infer<typeof LoopStateSchema>;
export type LoopRunStatus = z.infer<typeof LoopRunStatusSchema>;
export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>;
export type SandboxRef = z.infer<typeof SandboxRefSchema>;
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>;
export type TaskRunRecord = z.infer<typeof TaskRunRecordSchema>;
