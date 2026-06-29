import { describe, expect, it } from "vitest";

import { createInMemoryStateManager } from "../../src/index.ts";

describe("in-memory StateManager", () => {
  it("applies step reducers to Loop State drafts and increments revisions", async () => {
    const stateManager = createInMemoryStateManager();
    const workflow = await stateManager.createWorkflowRun({
      id: "workflow-state-reducer",
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
      defaultSandbox: {
        id: "sandbox-default",
        kind: "local-workspace",
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
      id: "workflow-active-task",
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
      defaultSandbox: {
        id: "sandbox-default",
        kind: "local-workspace",
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
      id: "workflow-cancel-task",
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
      defaultSandbox: {
        id: "sandbox-default",
        kind: "local-workspace",
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
      id: "workflow-invalid-transition",
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
      defaultSandbox: {
        id: "sandbox-default",
        kind: "local-workspace",
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

    await expect(stateManager.markTaskSucceeded(task.id, {})).rejects.toThrow("Cannot mark task");
  });

  it("renews and recovers task leases", async () => {
    const stateManager = createInMemoryStateManager();
    const workflow = await stateManager.createWorkflowRun({
      id: "workflow-lease-recovery",
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
      defaultSandbox: {
        id: "sandbox-default",
        kind: "local-workspace",
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
    const leased = await stateManager.markTaskLeased(task.id, "worker-1", 100);
    const renewed = await stateManager.renewTaskLease(task.id, "worker-1", 10_000);
    const recoveredBeforeExpiry = await stateManager.recoverExpiredLeases(new Date());

    expect(leased.leaseOwner).toBe("worker-1");
    expect(renewed.leaseExpiresAt).toBeDefined();
    expect(recoveredBeforeExpiry).toEqual([]);

    const recovered = await stateManager.recoverExpiredLeases(new Date(Date.now() + 20_000));

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("dispatched");
    expect(recovered[0]?.leaseOwner).toBeUndefined();
  });
});
