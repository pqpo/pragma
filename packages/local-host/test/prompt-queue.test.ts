import type { ExpertSessionStore } from "@pragma/core";
import type { ExpertSessionRecord, PromptRequest } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { createExpertSessionPromptQueueProjection } from "../src/index.ts";

describe("ExpertSession prompt queue projection", () => {
  it("treats uncertain delivery as paused even without a persisted pause event", async () => {
    const queued = {
      ...prompt("redirect", "execution-followup", "user"),
      deliveryAttempt: {
        kind: "queue_steer" as const,
        state: "uncertain" as const,
        attemptId: "attempt",
        sourceExecutionId: "execution-followup",
        targetExecutionId: "execution-active",
      },
    };
    const projection = createExpertSessionPromptQueueProjection({
      sessions: {
        get: async () => ({ activeExecutionId: undefined }) as ExpertSessionRecord,
        listPrompts: async () => [queued],
        listEvents: async () => [],
      },
      resolveSessionId: async () => "session",
      steeringFeatures: async () => ({ supportsSteer: true }),
    });

    await expect(projection.list("mission")).resolves.toMatchObject({
      state: "paused",
      pausedAfterRequestId: "redirect",
      items: [{ requestId: "redirect", steerable: false }],
    });
  });

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
      steeringFeatures: async () => ({ supportsSteer: true }),
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
  it.each(["receipt", "terminal", undefined] as const)(
    "projects uncertainty and %s recovery even when no pause event survived",
    async (recovery) => {
      const uncertain = {
        ...prompt("uncertain", "source", "user"),
        deliveryAttempt: {
          attemptId: "attempt",
          kind: "queue_steer" as const,
          sourceExecutionId: "source",
          targetExecutionId: "target",
          state: "uncertain" as const,
        },
      };
      const sessions = {
        get: async () => ({ activeExecutionId: undefined }) as ExpertSessionRecord,
        listPrompts: async () => [uncertain, prompt("next", "next", "user")],
        listEvents: async () => [],
      } as unknown as Pick<ExpertSessionStore, "get" | "listPrompts" | "listEvents">;
      const projection = createExpertSessionPromptQueueProjection({
        sessions,
        resolveSessionId: async () => "session",
        steeringFeatures: async () => ({ supportsSteer: true, steeringRecovery: recovery }),
      });
      await expect(projection.list("mission")).resolves.toMatchObject({
        state: "paused",
        deliveryUncertain: true,
        steeringRecovery: recovery,
        items: [{ steerable: false }, { steerable: false }],
      });
    },
  );
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
