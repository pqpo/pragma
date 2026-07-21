import { defineExpert, defineExpertTeam, defineFlow, type ExecutionOutputItem } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { FlowConsoleModel, renderFlowConsole } from "../src/console/flow-console-tui.ts";
import { HumanInteractionQueue } from "../src/console/human-interaction-controller.ts";

describe("FlowConsoleModel", () => {
  it("tracks route decisions and marks unselected branches as skipped", () => {
    const flow = defineFlow({ id: "review", version: "1.0.0" });
    const prepare = flow.task({ id: "prepare", version: "1.0.0", handler: () => ({}) });
    const review = flow.humanTask({
      id: "review",
      version: "1.0.0",
      request: { kind: "review_gate", prompt: "Choose" },
    });
    const approve = flow.task({ id: "approve", version: "1.0.0", handler: () => "approved" });
    const revise = flow.task({ id: "revise", version: "1.0.0", handler: () => "revised" });
    const reject = flow.task({ id: "reject", version: "1.0.0", handler: () => "rejected" });
    flow.compose(({ start, step, end }) => {
      start(prepare).next(review).route("decision", { approve, revise, reject });
      step(approve).next(end());
      step(revise).next(end());
      step(reject).next(end());
    });
    const model = new FlowConsoleModel(flow);
    model.syncTree(
      tree("flow", "flow", "running", [
        tree("prepare-invocation", "task", "succeeded", [], {
          nodeId: "prepare",
          input: { brief: true },
          output: { normalized: true },
        }),
        tree("review-invocation", "human-task", "succeeded", [], {
          nodeId: "review",
          output: { decision: "revise" },
        }),
        tree("revise-invocation", "task", "running", [], { nodeId: "revise" }),
      ]),
    );

    expect(model.nodes.get("step:approve")?.status).toBe("skipped");
    expect(model.nodes.get("step:reject")?.status).toBe("skipped");
    expect(model.nodes.get("step:revise")?.status).toBe("running");
    expect(model.nodes.get("step:prepare")?.input).toEqual({ brief: true });
    model.cycleView(1);
    expect(model.viewMode).toBe("input");
    model.moveSelection(1);
    expect(model.selected.nodeId).toBe("review");
    model.moveSelection(1);
    expect(model.selected.nodeId).toBe("approve");
    const skippedDetails = renderFlowConsole({
      model,
      interactions: new HumanInteractionQueue(),
      title: "Review",
      width: 120,
      height: 24,
    }).join("\n");
    expect(skippedDetails).toContain(
      'Route "approve" was not selected. Conditional branches are mutually',
    );
    expect(skippedDetails).toContain("No Activity, Input, or Output was produced.");
  });

  it("expands team participants and isolates their streamed activity", async () => {
    const lead = await defineExpert({
      id: "lead",
      name: "Review Lead",
      description: "Lead",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: process.cwd(),
    });
    const member = await defineExpert({
      id: "member",
      name: "Member",
      description: "Member",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: process.cwd(),
    });
    const team = defineExpertTeam({
      id: "review-team",
      version: "1.0.0",
      coordinator: lead,
      members: [member],
      delegation: { maxConcurrency: 2, maxDepth: 1 },
    });
    const flow = defineFlow({ id: "team-flow", version: "1.0.0" });
    const teamStep = flow.use("team", team);
    flow.compose(({ start, end }) => start(teamStep).next(end()));
    const model = new FlowConsoleModel(flow);
    model.syncTree(
      tree("flow", "flow", "running", [
        tree(
          "team-invocation",
          "expert-team",
          "running",
          [tree("member-invocation", "expert", "running", [], { executorId: "member" })],
          {
            nodeId: "team",
            executorId: "lead",
            agentId: "coordinator-agent",
            contextId: "review-context",
            contextResolution: {
              resolver: { id: "revision-context", version: "1.0.0" },
              disposition: "created",
            },
          },
        ),
      ]),
    );
    model.consumeOutput(output("member-invocation", "member", "thought", "Checking "));
    model.consumeOutput(output("member-invocation", "member", "thought", "constraints."));
    model.consumeOutput(
      outputValue("member-invocation", "member", "tool", {
        toolCallId: "tool-1",
        toolName: "lookup_requirement_evidence",
        inputPreview: { area: "architecture" },
      }),
    );
    model.consumeOutput(output("member-invocation", "member", "tool", "first"));
    model.consumeOutput(output("member-invocation", "member", "tool", "first result"));

    const teamNode = model.nodes.get("step:team")!;
    expect(teamNode.children).toHaveLength(2);
    expect(model.visibleNodes.map((node) => node.label)).toEqual(["Review Lead", "lead", "member"]);
    const memberNode = model.nodes.get("invocation:member-invocation")!;
    expect(memberNode.activity).toMatchObject([
      { kind: "thinking", text: "Checking constraints." },
      { kind: "tool", text: expect.stringContaining("lookup_requirement_evidence") },
      { kind: "tool-output", text: "first result" },
    ]);
    expect(teamNode.activity.some((item) => item.text.includes("[member]"))).toBe(true);
    model.toggleSelected();
    expect(model.visibleNodes).toHaveLength(1);
  });

  it("coalesces interleaved team deltas independently by participant and channel", async () => {
    const lead = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: process.cwd(),
    });
    const first = await defineExpert({
      id: "first",
      name: "First",
      description: "First",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: process.cwd(),
    });
    const second = await defineExpert({
      id: "second",
      name: "Second",
      description: "Second",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: process.cwd(),
    });
    const team = defineExpertTeam({
      id: "team",
      version: "1.0.0",
      coordinator: lead,
      members: [first, second],
      delegation: { maxConcurrency: 2, maxDepth: 1 },
    });
    const flow = defineFlow({ id: "interleaved", version: "1.0.0" });
    const teamStep = flow.use("team", team);
    flow.compose(({ start, end }) => start(teamStep).next(end()));
    const model = new FlowConsoleModel(flow);
    model.syncTree(
      tree("flow", "flow", "running", [
        tree(
          "team-invocation",
          "expert-team",
          "running",
          [
            tree("first-invocation", "expert", "running", [], { executorId: "first" }),
            tree("second-invocation", "expert", "running", [], { executorId: "second" }),
          ],
          {
            nodeId: "team",
            executorId: "lead",
            agentId: "coordinator-agent",
            contextId: "review-context",
            contextResolution: {
              resolver: { id: "revision-context", version: "1.0.0" },
              disposition: "created",
            },
          },
        ),
      ]),
    );

    model.consumeOutput(output("first-invocation", "first", "message", "first "));
    model.consumeOutput(output("second-invocation", "second", "thought", "checking "));
    model.consumeOutput(output("first-invocation", "first", "message", "answer"));
    model.consumeOutput(output("second-invocation", "second", "thought", "constraints"));

    expect(model.nodes.get("step:team")?.activity).toMatchObject([
      { kind: "answer", source: "first", text: "[first] first answer" },
      { kind: "thinking", source: "second", text: "[second] checking constraints" },
    ]);

    model.syncTree(
      tree("flow", "flow", "running", [
        tree(
          "team-invocation",
          "expert-team",
          "succeeded",
          [
            tree("first-invocation", "expert", "succeeded", [], { executorId: "first" }),
            tree("second-invocation", "expert", "succeeded", [], { executorId: "second" }),
          ],
          {
            nodeId: "team",
            executorId: "lead",
            agentId: "coordinator-agent",
            contextId: "review-context",
            contextResolution: {
              resolver: { id: "revision-context", version: "1.0.0" },
              disposition: "created",
            },
          },
        ),
        tree(
          "team-invocation-2",
          "expert-team",
          "running",
          [
            tree("first-invocation-2", "expert", "running", [], { executorId: "first" }),
            tree("second-invocation-2", "expert", "running", [], { executorId: "second" }),
          ],
          {
            nodeId: "team",
            executorId: "lead",
            agentId: "coordinator-agent",
            contextId: "review-context",
            contextResolution: {
              resolver: { id: "revision-context", version: "1.0.0" },
              disposition: "reused",
            },
          },
        ),
      ]),
    );
    model.consumeOutput(output("first-invocation-2", "first", "message", "revised answer"));

    const visits = model.nodes.get("step:team")?.visits;
    expect(visits).toHaveLength(2);
    expect(visits?.[0]?.activity).toContainEqual(
      expect.objectContaining({ source: "first", text: "[first] first answer" }),
    );
    expect(visits?.[1]?.activity).toContainEqual(
      expect.objectContaining({ source: "first", text: "[first] revised answer" }),
    );
    const rendered = renderFlowConsole({
      model,
      interactions: new HumanInteractionQueue(),
      title: "Review",
      width: 240,
      height: 40,
    }).join("\n");
    expect(rendered).toContain("Round 1 · succeeded");
    expect(rendered).toContain("Round 2 · running");
    expect(rendered).toContain("context review-context");
    expect(rendered).toContain("resolver revision-context@1.0.0");
    expect(rendered).toContain("reused");
  });

  it("makes terminal routes eligible again while a revision review is waiting", () => {
    const flow = defineFlow({ id: "revision-loop", version: "1.0.0" });
    const review = flow.humanTask({
      id: "review",
      version: "1.0.0",
      request: { kind: "review_gate", prompt: "Choose" },
    });
    const approve = flow.task({ id: "approve", version: "1.0.0", handler: () => "approved" });
    const revise = flow.task({ id: "revise", version: "1.0.0", handler: () => "revised" });
    const reject = flow.task({ id: "reject", version: "1.0.0", handler: () => "rejected" });
    flow.compose(({ start, step, end }) => {
      start(review).route("decision", { approve, revise, reject });
      step(revise).next(review);
      step(approve).next(end());
      step(reject).next(end());
    });
    const model = new FlowConsoleModel(flow);
    model.syncTree(
      tree("flow", "flow", "running", [
        tree("first-review", "human-task", "succeeded", [], {
          nodeId: "review",
          output: { decision: "revise" },
        }),
        tree("revision", "task", "succeeded", [], { nodeId: "revise" }),
      ]),
    );
    expect(model.nodes.get("step:approve")?.status).toBe("skipped");
    expect(model.nodes.get("step:reject")?.status).toBe("skipped");

    model.syncTree(
      tree("flow", "flow", "running", [
        tree("first-review", "human-task", "succeeded", [], {
          nodeId: "review",
          output: { decision: "revise" },
        }),
        tree("revision", "task", "succeeded", [], { nodeId: "revise" }),
        tree("second-review", "human-task", "waiting", [], { nodeId: "review" }),
      ]),
    );
    expect(model.nodes.get("step:approve")?.status).toBe("pending");
    expect(model.nodes.get("step:reject")?.status).toBe("pending");
    expect(model.nodes.get("step:revise")?.status).toBe("succeeded");
  });

  it("renders wide and stacked layouts with node details", () => {
    const flow = defineFlow({ id: "render", version: "1.0.0" });
    const task = flow.task({ id: "prepare", version: "1.0.0", handler: () => "done" });
    flow.compose(({ start, end }) => start(task).next(end()));
    const model = new FlowConsoleModel(flow);
    const queue = new HumanInteractionQueue();
    const wide = renderFlowConsole({
      model,
      interactions: queue,
      title: "Review",
      width: 120,
      height: 24,
    });
    const narrow = renderFlowConsole({
      model,
      interactions: queue,
      title: "Review",
      width: 80,
      height: 24,
    });
    expect(wide.some((line) => line.includes(" │ "))).toBe(true);
    expect(narrow.some((line) => line.includes("Activity"))).toBe(true);
    expect(wide.length).toBeLessThanOrEqual(24);
    expect(narrow.length).toBeLessThanOrEqual(24);
    const tooSmall = renderFlowConsole({
      model,
      interactions: queue,
      title: "Review",
      width: 40,
      height: 10,
    });
    expect(tooSmall.join(" ")).toContain("Terminal too small");
    expect(tooSmall.every((line) => line.length <= 40)).toBe(true);
  });
});

type FlowTree = Parameters<FlowConsoleModel["syncTree"]>[0];

function tree(
  invocationId: string,
  kind: "expert" | "expert-team" | "flow" | "human-task" | "task",
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted",
  children: FlowTree[] = [],
  overrides: {
    readonly nodeId?: string;
    readonly executorId?: string;
    readonly agentId?: string;
    readonly contextId?: string;
    readonly contextResolution?: {
      readonly resolver: { readonly id: string; readonly version: string };
      readonly disposition: "created" | "reused";
    };
    readonly input?: unknown;
    readonly output?: unknown;
  } = {},
) {
  const now = new Date().toISOString();
  return {
    invocation: {
      invocationId,
      rootInvocationId: "flow",
      definition: { id: overrides.nodeId ?? invocationId, version: "1.0.0", kind },
      contextId: overrides.contextId ?? invocationId,
      status,
      input: overrides.input ?? null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    children,
  } as FlowTree;
}

function output(
  invocationId: string,
  executorId: string,
  channel: ExecutionOutputItem["channel"],
  delta: string,
): ExecutionOutputItem {
  return {
    sourceEventId: `${invocationId}-${channel}-${delta}`,
    executionId: "execution",
    invocationId,
    executorId,
    contextId: invocationId,
    runId: `${invocationId}-run`,
    source: { kind: "agent", runId: `${invocationId}-run`, path: [] },
    channel,
    delta,
    occurredAt: new Date().toISOString(),
  };
}

function outputValue(
  invocationId: string,
  executorId: string,
  channel: ExecutionOutputItem["channel"],
  value: unknown,
): ExecutionOutputItem {
  return { ...output(invocationId, executorId, channel, ""), delta: undefined, value };
}
