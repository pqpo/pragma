import { z } from "zod";

export const RunStateSchema = z.object({
  input: z.unknown(),
  context: z.record(z.string(), z.unknown()).default({}),
  artifacts: z.record(z.string(), z.unknown()).default({}),
  results: z.record(z.string(), z.unknown()).default({}),
  flags: z.record(z.string(), z.boolean()).default({}),
  messages: z.array(z.unknown()).default([]),
  metrics: z.record(z.string(), z.unknown()).default({}),
  private: z.record(z.string(), z.unknown()).default({}),
});

export const RunStatusSchema = z.enum([
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
  "waiting",
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

export const RuntimeSessionRefSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

export const DefinitionRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  kind: z.enum(["flow", "task", "human", "expert", "directive"]),
});

export const WorkflowResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), output: z.unknown() }),
  z.object({ status: z.literal("failed"), error: z.unknown() }),
  z.object({ status: z.literal("cancelled"), error: z.unknown().optional() }),
]);

export const WorkflowRunRecordSchema = z.object({
  id: z.string().min(1),
  rootWorkflowRunId: z.string().min(1),
  directiveId: z.string().min(1),
  directiveVersion: z.string().min(1),
  parentWorkflowRunId: z.string().min(1).optional(),
  parentTaskRunId: z.string().min(1).optional(),
  continuationKey: z.string().min(1).optional(),
  status: RunStatusSchema,
  input: z.unknown(),
  execution: z.object({
    runtime: z.string().min(1).optional(),
    modelName: z.string().min(1).optional(),
    thinkingLevel: z.string().min(1).optional(),
    runtimes: z.record(z.string(), z.string().min(1)).optional(),
  }),
  state: RunStateSchema,
  defaultSandbox: SandboxRefSchema,
  currentStepIds: z.array(z.string().min(1)),
  completedStepIds: z.array(z.string().min(1)),
  revision: z.number().int().nonnegative(),
  result: WorkflowResultSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const TaskRunRecordSchema = z.object({
  id: z.string().min(1),
  workflowRunId: z.string().min(1),
  stepId: z.string().min(1),
  definition: DefinitionRefSchema,
  visit: z.number().int().positive(),
  status: TaskRunStatusSchema,
  runtimeId: z.string().min(1),
  sandbox: SandboxRefSchema.optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  systemSessionId: z.string().min(1).optional(),
  runtimeSession: RuntimeSessionRefSchema.optional(),
  runtimeSessionOwnerTaskRunId: z.string().min(1).optional(),
  runtimeSessionState: z.enum(["not_started", "creating", "opened"]),
  completionApplied: z.boolean(),
  transitionApplied: z.boolean(),
  error: z.unknown().optional(),
  attempt: z.number().int().positive(),
  leaseOwner: z.string().min(1).optional(),
  leaseExpiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RunState = z.infer<typeof RunStateSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>;
export type SandboxRef = z.infer<typeof SandboxRefSchema>;
export type RuntimeSessionRef = z.infer<typeof RuntimeSessionRefSchema>;
export type DefinitionRef = z.infer<typeof DefinitionRefSchema>;
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
export type WorkflowRunRecord = z.infer<typeof WorkflowRunRecordSchema>;
export type TaskRunRecord = z.infer<typeof TaskRunRecordSchema>;
