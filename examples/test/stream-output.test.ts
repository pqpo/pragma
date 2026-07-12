import { describe, expect, it } from "vitest";

import type { PragmaRunEvent } from "@pragma/core";

import { readRuntimeStreamEvent } from "../src/harness/stream-output.ts";

describe("readRuntimeStreamEvent", () => {
  it.each(["task.progress", "task.output.delta"])(
    "rehydrates projected %s events for stream printing",
    (sourceType) => {
      const event = createRunEvent(sourceType);

      expect(readRuntimeStreamEvent(event)).toMatchObject({
        schemaVersion: "pragma.stream/v1",
        eventId: event.id,
        sequence: event.cursor.sequence,
        runId: event.taskRunId,
        type: "message.delta",
        payload: {
          role: "assistant",
          contentType: "text",
          delta: "streamed",
        },
      });
    },
  );

  it("ignores workflow lifecycle events", () => {
    expect(readRuntimeStreamEvent(createRunEvent("workflow.completed"))).toBeUndefined();
  });
});

function createRunEvent(sourceType: string): PragmaRunEvent {
  return {
    id: "event-1",
    cursor: { rootWorkflowRunId: "parent-workflow", sequence: 3 },
    rootWorkflowRunId: "parent-workflow",
    workflowRunId: "child-workflow",
    parentWorkflowRunId: "parent-workflow",
    taskRunId: "child-task",
    stepId: "child-agent",
    type: "message.delta",
    sourceType,
    payload: {
      role: "assistant",
      contentType: "text",
      delta: "streamed",
    },
    occurredAt: "2026-07-12T00:00:00.000Z",
  };
}
