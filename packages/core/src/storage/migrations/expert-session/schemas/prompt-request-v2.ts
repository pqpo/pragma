import { RuntimeModelSelectionSchema } from "@pragma/shared";
import { z } from "zod";

export const PromptDeliveryAttemptV2Schema = z
  .object({
    attemptId: z.string().min(1),
    kind: z.enum(["strict_steer", "queue_steer"]),
    sourceExecutionId: z.string().min(1).optional(),
    targetExecutionId: z.string().min(1),
    state: z.enum(["dispatching", "confirmed", "not_dispatched", "uncertain"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "queue_steer" && value.sourceExecutionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceExecutionId"],
        message: "Queue steer delivery attempts require the source Execution.",
      });
    }
  });

/** Prompt records written by ExpertSession v6 before queue-steer markers were migrated. */
export const PromptRequestV2Schema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  purpose: z.enum(["user", "human_checkpoint_recovery"]).default("user"),
  mode: z.enum(["enqueue", "steer"]),
  executionId: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]),
  modelSelection: RuntimeModelSelectionSchema.optional(),
  targetExecutionId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  deliveryAttempt: PromptDeliveryAttemptV2Schema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
