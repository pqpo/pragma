import { z } from "zod";

export const RunEventCursorSchema = z.object({
  rootWorkflowRunId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});

export const PragmaRunEventSchema = z.object({
  id: z.string().min(1),
  cursor: RunEventCursorSchema,
  rootWorkflowRunId: z.string().min(1),
  workflowRunId: z.string().min(1),
  parentWorkflowRunId: z.string().min(1).optional(),
  parentTaskRunId: z.string().min(1).optional(),
  taskRunId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  type: z.string().min(1),
  sourceType: z.string().min(1),
  payload: z.unknown(),
  occurredAt: z.string().datetime(),
});

export type RunEventCursor = z.infer<typeof RunEventCursorSchema>;
export type PragmaRunEvent<TPayload = unknown> = Omit<
  z.infer<typeof PragmaRunEventSchema>,
  "payload"
> & { readonly payload: TPayload };
