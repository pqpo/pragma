import { z } from "zod";

export const MailboxMessageKindSchema = z.enum(["command", "event"]);

export const MailboxProducerKindSchema = z.enum([
  "task-manager",
  "task-worker",
  "runtime",
  "operator",
  "external",
]);

export const MailboxMessageTypeSchema = z.enum([
  "workflow.started",
  "workflow.waiting",
  "workflow.resumed",
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
  "task.dispatch",
  "task.leased",
  "task.started",
  "task.waiting",
  "task.resumed",
  "task.progress",
  "task.output.delta",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.heartbeat",
  "sandbox.created",
  "sandbox.attached",
  "sandbox.reused",
  "sandbox.released",
  "human.requested",
  "human.responded",
]);

export const MailboxProducerSchema = z.object({
  id: z.string().min(1),
  kind: MailboxProducerKindSchema,
});

export const MailboxMessageSchema = z.object({
  id: z.string().min(1),
  kind: MailboxMessageKindSchema,
  type: MailboxMessageTypeSchema,
  workflowRunId: z.string().min(1),
  taskRunId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  parentWorkflowRunId: z.string().min(1).optional(),
  parentTaskRunId: z.string().min(1).optional(),
  causationId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
  occurredAt: z.string().datetime(),
  producer: MailboxProducerSchema,
});

export type MailboxMessageKind = z.infer<typeof MailboxMessageKindSchema>;
export type MailboxProducerKind = z.infer<typeof MailboxProducerKindSchema>;
export type MailboxMessageType = z.infer<typeof MailboxMessageTypeSchema>;
export type MailboxProducer = z.infer<typeof MailboxProducerSchema>;
export type MailboxMessage<TPayload = unknown> = Omit<
  z.infer<typeof MailboxMessageSchema>,
  "payload"
> & {
  readonly payload: TPayload;
};
