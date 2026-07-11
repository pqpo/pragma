import { describe, expect, it } from "vitest";

import {
  EXECUTION_RUNTIME_SESSION_ATTR,
  readExecutionRunScope,
  withExecutionRunScope,
} from "../../src/runtime/run-context.ts";

describe("execution run scope", () => {
  it("round-trips a complete runtime session ref", () => {
    const context = withExecutionRunScope(undefined, {
      workflowRunId: "workflow-1",
      taskRunId: "task-1",
      runtimeSession: { type: "codex-local", id: "thread-1" },
    });

    expect(context.attributes?.[EXECUTION_RUNTIME_SESSION_ATTR]).toEqual({
      type: "codex-local",
      id: "thread-1",
    });
    expect(readExecutionRunScope(context)).toEqual({
      workflowRunId: "workflow-1",
      taskRunId: "task-1",
      runtimeSession: { type: "codex-local", id: "thread-1" },
    });
  });

  it("does not interpret a naked runtime session id as a runtime session ref", () => {
    expect(
      readExecutionRunScope({
        attributes: {
          [EXECUTION_RUNTIME_SESSION_ATTR]: "thread-1",
        },
      }).runtimeSession,
    ).toBeUndefined();
  });
});
