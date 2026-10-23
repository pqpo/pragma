import { getToolResultText } from "../src/tools/managed-tool.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { createAgentLauncher, type ExpertLifecycleToolName } from "../src/agent/agent-launcher.ts";
import { defineExpert as createExpert } from "../src/index.ts";

let launcher: ReturnType<typeof createAgentLauncher>;
beforeAll(async () => {
  const expert = await createExpert({
    id: "worker",
    name: "Worker",
    description: "Test worker",
    tags: [],
    scope: "test",
    workspace: process.cwd(),
  });
  launcher = createAgentLauncher({ experts: [expert] });
});

const operations = {
  spawn_expert: "spawnExpert",
  continue_expert: "continueExpert",
  wait_experts: "waitExperts",
  list_agents: "listAgents",
  steer_expert: "steerExpert",
  interrupt_expert: "interruptExpert",
} as const;
const inputs = {
  spawn_expert: { expertId: "worker", task: "Review" },
  continue_expert: { contextId: "context", task: "Follow up" },
  wait_experts: { invocationIds: ["task"] },
  list_agents: {},
  steer_expert: { invocationId: "task", instruction: "Focus", delivery: "after_current" },
  interrupt_expert: { invocationId: "task" },
};

async function call(name: ExpertLifecycleToolName, value: unknown) {
  const before = structuredClone(value);
  const result = await launcher.tools
    .find((tool) => tool.name === name)!
    .call(inputs[name], undefined, {
      execution: {
        executionId: "execution",
        invocationId: "root",
        depth: 0,
        [operations[name]]: async () => value,
      },
    });
  expect(result.isError, getToolResultText(result)).not.toBe(true);
  expect(result.details).toEqual(JSON.parse(getToolResultText(result)));
  expect(value).toEqual(before);
  return JSON.parse(getToolResultText(result));
}

describe("Expert lifecycle results", () => {
  it("returns an actionable acceptance receipt and a distinct new continuation id", async () => {
    const spawned = await call("spawn_expert", {
      expertId: "worker",
      contextId: "context",
      agentId: "internal-agent",
      invocationId: "first",
      status: "queued",
    });
    expect(spawned).toEqual({
      expertId: "worker",
      contextId: "context",
      invocationId: "first",
      status: "queued",
      message: expect.stringContaining("not a completion result"),
    });
    expect(spawned.message).toContain("wait_experts");
    const continued = await call("continue_expert", {
      contextId: "context",
      agentId: "internal-agent",
      agentDisposition: "materialized",
      invocationId: "next",
      status: "queued",
    });
    expect(continued).toEqual({
      contextId: "context",
      invocationId: "next",
      status: "queued",
      message: expect.stringContaining("NEW invocationId"),
    });
    expect(continued.message).toContain("FIFO");
  });

  it("preserves wait diagnostics, structured output references, usage, and nested identities", async () => {
    const completed = {
      contextId: "context",
      invocationId: "task",
      status: "failed",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:01:00Z",
      output: {
        type: "context",
        summary: "Partial report",
        contexts: [
          {
            namespace: "reports",
            id: "review.md",
            revision: "r1",
            sizeBytes: 12,
            mediaType: "text/markdown",
          },
        ],
      },
      error: {
        code: "review_failed",
        message: "Needs retry",
        details: { agentId: "business-data" },
      },
      usage: { input: 100, output: 20, totalTokens: 120 },
    };
    const pending = {
      contextId: "other-context",
      invocationId: "pending-task",
      status: "waiting",
      waitReason: "human_input",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:02:00Z",
      latestActivity: {
        kind: "tool",
        phase: "started",
        toolName: "approve",
        occurredAt: "2026-10-23T00:02:00Z",
        ageMs: 500,
      },
    };
    const result = await call("wait_experts", {
      returnWhen: "any",
      timedOut: false,
      waitedMs: 123,
      completed: [{ ...completed, agentId: "internal-agent" }],
      pending: [{ ...pending, agentId: "other-agent" }],
      wakeReason: "steer",
      steer: { requestId: "guidance", content: "New priorities" },
    });
    expect(result).toEqual({
      returnWhen: "any",
      timedOut: false,
      waitedMs: 123,
      completed: [completed],
      pending: [pending],
      wakeReason: "steer",
      steer: { requestId: "guidance", content: "New priorities" },
      message: expect.stringContaining("New guidance"),
    });
    expect(result.message).toContain("1 task(s) remain pending");
    expect(result.message).toContain("wait_experts");
    expect(result.message).not.toContain("still running");
  });

  it.each(["succeeded", "failed", "cancelled", "interrupted"])(
    "describes %s as terminal without claiming success",
    async (status) => {
      const result = await call("wait_experts", {
        returnWhen: "all",
        timedOut: false,
        waitedMs: 5,
        completed: [
          {
            invocationId: "task",
            contextId: "context",
            status,
            output: { agentId: "output-data" },
          },
        ],
        pending: [],
      });
      expect(result.completed[0].output).toEqual({ agentId: "output-data" });
      expect(result.message).toContain("All requested tasks are terminal");
      expect(result.message).toContain("Inspect each status, output, and error");
    },
  );

  it.each(["queued", "running", "waiting"])(
    "does not cancel or mislabel %s work on timeout",
    async (status) => {
      const result = await call("wait_experts", {
        timedOut: true,
        waitedMs: 30_000,
        completed: [],
        pending: [{ invocationId: "task", contextId: "context", status }],
      });
      expect(result.message).toContain("timed out; no task was cancelled");
      expect(result.message).toContain("alone does not justify interrupting");
      expect(result.pending[0].status).toBe(status);
    },
  );

  it("handles message wakeups without suggesting all tasks have finished", async () => {
    const result = await call("wait_experts", {
      timedOut: false,
      waitedMs: 10,
      completed: [],
      pending: [{ invocationId: "task", status: "running" }],
      wakeReason: "message",
    });
    expect(result.message).toContain("New messages woke this wait");
    expect(result.message).toContain("remain pending");
  });

  it("preserves directory permissions, summaries, pagination, and queue truncation", async () => {
    const context = {
      expertId: "worker",
      contextId: "context",
      scope: "current",
      status: "running",
      canContinue: true,
      canInterrupt: false,
      canSteerNextBoundary: true,
      canQueueAfterCurrent: true,
      currentInvocation: { invocationId: "task", status: "running", taskSummary: "Review" },
      queuedInvocations: {
        total: 21,
        items: [{ invocationId: "next", taskSummary: "Follow up" }],
        truncated: true,
      },
      recentTerminal: { invocationId: "old", status: "failed", errorSummary: "Needs retry" },
    };
    const availableExperts = [
      { expertId: "worker", name: "Worker", description: "Reviewer", canSpawn: true },
    ];
    const result = await call("list_agents", {
      availableExperts,
      contexts: [{ ...context, agentId: "internal" }],
      nextCursor: "cursor",
    });
    expect(result).toEqual({
      availableExperts,
      contexts: [context],
      nextCursor: "cursor",
      message: expect.any(String),
    });
    expect(result.message).toContain("visibility does not grant permission");
    expect(result.message).toContain("created directly by your current task");
  });

  it.each([
    { outcome: "accepted", delivery: "after_current", messageId: "guidance" },
    { outcome: "steered", delivery: "next_boundary", mode: "runtime" },
    { outcome: "steered", delivery: "next_boundary", mode: "waiting_continuation" },
  ])("preserves steer receipt %j without claiming completion", async (receipt) => {
    const result = await call("steer_expert", {
      ...receipt,
      agentId: "internal",
      contextId: "context",
      invocationId: "task",
    });
    expect(result).toEqual({
      ...receipt,
      contextId: "context",
      invocationId: "task",
      message: expect.stringContaining("not task completion"),
    });
    if (receipt.delivery === "after_current")
      expect(result.message).toContain("not necessarily been applied");
  });

  it.each(["interrupted", "cancelled", "already_terminal"])(
    "explains interrupt outcome %s",
    async (outcome) => {
      const result = await call("interrupt_expert", {
        agentId: "internal",
        contextId: "context",
        invocationId: "task",
        outcome,
      });
      expect(result).toEqual({
        contextId: "context",
        invocationId: "task",
        outcome,
        message: expect.any(String),
      });
      expect(result.message).toContain("Runtime Context");
      expect(result.message).toContain(
        outcome === "already_terminal" ? "does not imply success" : "not completed successfully",
      );
    },
  );

  it("preserves the error contract and structured Host details", async () => {
    const tool = launcher.tools.find((tool) => tool.name === "spawn_expert")!;
    const result = await tool.call(inputs.spawn_expert, undefined, {
      execution: {
        executionId: "execution",
        invocationId: "root",
        depth: 0,
        spawnExpert: async () => {
          throw new Error("delegation denied");
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.details).toEqual(JSON.parse(getToolResultText(result)));
    expect(JSON.parse(getToolResultText(result))).toEqual({
      ok: false,
      committed: false,
      code: "spawn_expert_failed",
      error: { code: "spawn_expert_failed", message: "delegation denied" },
    });
  });
});
