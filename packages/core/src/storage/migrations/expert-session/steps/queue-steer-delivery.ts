import { PromptRequestSchema, type PromptRequest } from "@pragma/shared";

import { PromptRequestV2Schema } from "../schemas/prompt-request-v2.ts";

const QUEUE_STEER_PENDING_PREFIX = "__pragma_queue_steer_pending__:";

export function migrateQueueSteerDeliveryAttempts(prompts: readonly unknown[]): PromptRequest[] {
  return PromptRequestV2Schema.array()
    .parse(prompts)
    .map((prompt) => {
      if (prompt.error?.startsWith(QUEUE_STEER_PENDING_PREFIX) !== true) {
        return PromptRequestSchema.parse(prompt);
      }
      const sourceExecutionId = prompt.error.slice(QUEUE_STEER_PENDING_PREFIX.length);
      if (sourceExecutionId === "") {
        throw new Error(`Queue-steer marker is missing its source Execution: ${prompt.requestId}`);
      }
      const migrated = { ...prompt };
      delete migrated.error;
      return PromptRequestSchema.parse({
        ...migrated,
        deliveryAttempt: {
          attemptId: `legacy-queue-steer:${prompt.requestId}`,
          kind: "queue_steer",
          sourceExecutionId,
          targetExecutionId: prompt.targetExecutionId ?? prompt.executionId,
          state: prompt.status === "succeeded" ? "confirmed" : "dispatching",
        },
      });
    });
}
