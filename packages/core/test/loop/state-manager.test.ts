import { describe, expect, it } from "vitest";

import { createInMemoryStateManager } from "../../src/index.ts";

describe("in-memory StateManager", () => {
  it("applies step reducers to Loop State drafts and increments revisions", async () => {
    const stateManager = createInMemoryStateManager();
    const workflow = await stateManager.createWorkflowRun({
      loopId: "loop",
      input: {
        value: 1,
      },
      state: {
        input: {
          value: 1,
        },
        context: {},
        artifacts: {},
        results: {},
        flags: {},
        messages: [],
        metrics: {},
        private: {},
      },
      startStepId: "review",
    });
    const task = await stateManager.createTaskRun({
      workflowRunId: workflow.id,
      stepId: "review",
      visit: 1,
      runtimeId: "local",
      input: {},
    });

    const nextState = await stateManager.applyStepReduction({
      workflowRunId: workflow.id,
      taskRunId: task.id,
      stepId: "review",
      output: {
        decision: "approved",
      },
      expectedRevision: 0,
      reduce: ({ state, output }) => {
        state.results["review"] = output;
        state.flags["reviewApproved"] = true;
      },
    });

    const updatedWorkflow = await stateManager.getWorkflowRun(workflow.id);

    expect(nextState.flags["reviewApproved"]).toBe(true);
    expect(updatedWorkflow?.revision).toBe(1);
    expect(updatedWorkflow?.state.results["review"]).toEqual({
      decision: "approved",
    });
  });

  it("rejects duplicate active task runs for the same workflow step", async () => {
    const stateManager = createInMemoryStateManager();
    const workflow = await stateManager.createWorkflowRun({
      loopId: "loop",
      input: {},
      state: {
        input: {},
        context: {},
        artifacts: {},
        results: {},
        flags: {},
        messages: [],
        metrics: {},
        private: {},
      },
      startStepId: "review",
    });

    await stateManager.createTaskRun({
      workflowRunId: workflow.id,
      stepId: "review",
      visit: 1,
      runtimeId: "local",
      input: {},
    });

    await expect(
      stateManager.createTaskRun({
        workflowRunId: workflow.id,
        stepId: "review",
        visit: 2,
        runtimeId: "local",
        input: {},
      }),
    ).rejects.toThrow("Active task run already exists");
  });

  it("tracks task cancellation as a cancelled status", async () => {
    const stateManager = createInMemoryStateManager();
    const workflow = await stateManager.createWorkflowRun({
      loopId: "loop",
      input: {},
      state: {
        input: {},
        context: {},
        artifacts: {},
        results: {},
        flags: {},
        messages: [],
        metrics: {},
        private: {},
      },
      startStepId: "review",
    });
    const task = await stateManager.createTaskRun({
      workflowRunId: workflow.id,
      stepId: "review",
      visit: 1,
      runtimeId: "local",
      input: {},
    });

    const cancelledTask = await stateManager.markTaskCancelled(task.id, "No longer needed.");

    expect(cancelledTask.status).toBe("cancelled");
    expect(cancelledTask.error).toEqual({
      code: "task_cancelled",
      message: "No longer needed.",
      retryable: false,
    });
  });

  it("rejects invalid task state transitions", async () => {
    const stateManager = createInMemoryStateManager();
    const workflow = await stateManager.createWorkflowRun({
      loopId: "loop",
      input: {},
      state: {
        input: {},
        context: {},
        artifacts: {},
        results: {},
        flags: {},
        messages: [],
        metrics: {},
        private: {},
      },
      startStepId: "review",
    });
    const task = await stateManager.createTaskRun({
      workflowRunId: workflow.id,
      stepId: "review",
      visit: 1,
      runtimeId: "local",
      input: {},
    });

    await expect(stateManager.markTaskSucceeded(task.id, {})).rejects.toThrow(
      "Cannot mark task",
    );
  });
});
