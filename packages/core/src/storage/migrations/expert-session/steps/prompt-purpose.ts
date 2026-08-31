import { PromptRequestSchema, type PromptRequest } from "@pragma/shared";

import { PromptRequestV1Schema } from "../schemas/prompt-request-v1.ts";

export function migratePromptPurposes(
  prompts: readonly unknown[],
  events: readonly { readonly type: string; readonly data: unknown }[],
): PromptRequest[] {
  const humanCheckpointExecutions = new Set<string>();
  for (const event of events) {
    if (event.type !== "execution.attached" && event.type !== "execution.detached") continue;
    if (!isRecord(event.data) || typeof event.data.executionId !== "string") continue;
    if (event.type === "execution.detached" && event.data.status === "waiting") {
      humanCheckpointExecutions.add(event.data.executionId);
    } else {
      humanCheckpointExecutions.delete(event.data.executionId);
    }
  }
  return PromptRequestV1Schema.array()
    .parse(prompts)
    .map((prompt) =>
      PromptRequestSchema.parse({
        ...prompt,
        purpose:
          prompt.mode === "enqueue" &&
          prompt.status === "queued" &&
          humanCheckpointExecutions.has(prompt.executionId)
            ? "human_checkpoint_recovery"
            : "user",
      }),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
