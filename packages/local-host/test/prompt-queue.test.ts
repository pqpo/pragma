import type { ExpertSessionStore } from "@pragma/core";
import type { ExpertSessionRecord, PromptRequest } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { createExpertSessionPromptQueueProjection } from "../src/index.ts";

describe("ExpertSession prompt queue projection", () => {
  it("keeps a human checkpoint recovery prompt out of the user queue", async () => {
    const recovery = prompt("recovery", "execution-waiting", "human_checkpoint_recovery");
    const followup = prompt("followup", "execution-followup", "user");
    const sessions = {
      get: async () => ({ activeExecutionId: undefined }) as ExpertSessionRecord,
      listPrompts: async () => [recovery, followup],
      listEvents: async () => [],
    } as unknown as Pick<ExpertSessionStore, "get" | "listPrompts" | "listEvents">;
    const projection = createExpertSessionPromptQueueProjection({
      sessions,
      resolveSessionId: async () => "session",
      supportsSteer: async () => true,
    });

    await expect(projection.list("mission")).resolves.toMatchObject({
      state: "running",
      pendingCount: 1,
      items: [
        {
          position: 1,
          requestId: followup.requestId,
          executionId: followup.executionId,
          steerable: true,
        },
      ],
    });
  });
});

function prompt(
  requestId: string,
  executionId: string,
  purpose: PromptRequest["purpose"],
): PromptRequest {
  return {
    requestId,
    sessionId: "session",
    content: requestId,
    purpose,
    mode: "enqueue",
    executionId,
    status: "queued",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}
