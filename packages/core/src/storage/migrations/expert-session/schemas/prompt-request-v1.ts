import { RuntimeModelSelectionSchema } from "@pragma/shared";
import { z } from "zod";

/** Prompt records written before durable purpose and steer delivery metadata existed. */
export const PromptRequestV1Schema = z.object({
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  content: z.string().min(1),
  mode: z.enum(["enqueue", "steer"]),
  executionId: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]),
  modelSelection: RuntimeModelSelectionSchema.optional(),
  targetExecutionId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
