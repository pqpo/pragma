import type { ExecutionOutputItem } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { ExpertConsoleModel } from "../src/console/expert-console-tui.ts";

const agents = [
  { id: "lead", name: "Lead", shortName: "Lead", primary: true },
  { id: "research", name: "Research", shortName: "Research" },
  { id: "tests", name: "Tests", shortName: "Tests" },
] as const;

describe("ExpertConsoleModel", () => {
  it("supports a single primary Expert", () => {
    const model = new ExpertConsoleModel([
      { id: "expert", name: "Expert", shortName: "Expert", primary: true },
    ]);

    model.beginTurn("Hello");
    model.consume(output("expert", "thought", "Considering the request."));
    model.consume(output("expert", "message", "Hello!"));

    expect(model.selected.definition.id).toBe("expert");
    expect(model.selected.status).toBe("working");
    expect(model.selected.sections).toMatchObject([
      { kind: "user", text: "Hello" },
      { kind: "thinking", text: "Considering the request." },
      { kind: "answer", text: "Hello!" },
    ]);
  });

  it("tracks the lead conversation and member activity independently", () => {
    const model = new ExpertConsoleModel(agents);

    model.beginTurn("Review delegation.");
    model.consume(output("research", "thought", "Inspecting "));
    model.consume(output("research", "thought", "the runner."));
    model.consume(
      outputValue("research", "tool", {
        toolCallId: "call-1",
        toolName: "read",
        inputPreview: { path: "packages/core/src/execution/expert-runner.ts" },
      }),
    );

    expect(model.panes[0]?.status).toBe("working");
    expect(model.panes[0]?.sections).toMatchObject([{ kind: "user", text: "Review delegation." }]);
    expect(model.panes[1]?.status).toBe("working");
    expect(model.panes[1]?.sections).toMatchObject([
      { kind: "thinking", text: "Inspecting the runner." },
      { kind: "tool", text: expect.stringContaining("→ read") },
    ]);
    expect(model.panes[2]?.status).toBe("idle");
  });

  it("syncs Invocation status and supports focus switching without mixing logs", () => {
    const model = new ExpertConsoleModel(agents);
    model.beginTurn("Review delegation.");
    model.syncTree(
      tree("lead", "running", [tree("research", "succeeded"), tree("tests", "running")]),
    );

    expect(model.panes.map((pane) => pane.status)).toEqual(["working", "done", "working"]);
    expect(model.selected.definition.id).toBe("lead");

    model.setAwaitingInput("research", true);
    expect(model.panes[1]?.status).toBe("input");
    model.syncTree(
      tree("lead", "running", [tree("research", "waiting"), tree("tests", "running")]),
    );
    expect(model.panes[1]?.status).toBe("input");
    model.setAwaitingInput("research", false);

    model.cycleSelection(1);
    expect(model.selected.definition.id).toBe("research");
    model.select(2);
    expect(model.selected.definition.id).toBe("tests");
    model.selectPrimary();
    expect(model.selected.definition.id).toBe("lead");
  });

  it("requires a unique lead and unique member ids", () => {
    expect(
      () =>
        new ExpertConsoleModel([
          { id: "one", name: "One", shortName: "One" },
          { id: "two", name: "Two", shortName: "Two" },
        ]),
    ).toThrow("primary Agent");
    expect(
      () =>
        new ExpertConsoleModel([
          { id: "one", name: "One", shortName: "One", primary: true },
          { id: "two", name: "Two", shortName: "Two", primary: true },
        ]),
    ).toThrow("exactly one primary Agent");
    expect(
      () =>
        new ExpertConsoleModel([
          { id: "same", name: "Lead", shortName: "Lead", primary: true },
          { id: "same", name: "Member", shortName: "Member" },
        ]),
    ).toThrow("unique");
  });

  it("keeps completed-only answers from later turns", () => {
    const model = new ExpertConsoleModel(agents);

    model.beginTurn("First");
    model.consume(outputValue("lead", "message", "First answer"));
    model.beginTurn("Second");
    model.consume({
      ...outputValue("lead", "message", "Second answer"),
      invocationId: "lead-invocation-2",
    });

    expect(model.panes[0]?.sections.filter((section) => section.kind === "answer")).toMatchObject([
      { text: "First answer" },
      { text: "Second answer" },
    ]);
  });

  it("deduplicates cumulative tool snapshots while preserving true deltas", () => {
    const model = new ExpertConsoleModel(agents);
    model.beginTurn("Inspect the repository.");
    model.consume(
      outputValue("research", "tool", {
        toolCallId: "call-1",
        toolName: "bash",
        inputPreview: { command: "rg createAgentLauncher" },
      }),
    );
    model.consume(output("research", "tool", "createAgent"));
    model.consume(output("research", "tool", "createAgentLauncher\n"));
    model.consume(output("research", "tool", "packages/core/src/agent-launcher.ts\n"));

    expect(model.panes[1]?.sections.find((section) => section.kind === "tool-output")?.text).toBe(
      "createAgentLauncher\npackages/core/src/agent-launcher.ts\n",
    );
  });
});

function output(
  executorId: string,
  channel: ExecutionOutputItem["channel"],
  delta: string,
): ExecutionOutputItem {
  return {
    sourceEventId: `${executorId}-${channel}`,
    executionId: "execution",
    invocationId: `${executorId}-invocation`,
    executorId,
    contextId: `${executorId}-context`,
    runId: `${executorId}-run`,
    source: { kind: "agent", runId: `${executorId}-run`, path: [] },
    channel,
    delta,
    occurredAt: new Date().toISOString(),
  };
}

function outputValue(
  executorId: string,
  channel: ExecutionOutputItem["channel"],
  value: unknown,
): ExecutionOutputItem {
  return { ...output(executorId, channel, ""), delta: undefined, value };
}

function tree(executorId: string, status: string, children: unknown[] = []) {
  const now = new Date().toISOString();
  return {
    invocation: {
      invocationId: `${executorId}-invocation`,
      rootInvocationId: "lead-invocation",
      definition: { id: executorId, version: "1.0.0", kind: "expert" },
      executorId,
      contextId: `${executorId}-context`,
      status,
      input: "prompt",
      createdAt: now,
      updatedAt: now,
    },
    children,
  } as Parameters<ExpertConsoleModel["syncTree"]>[0];
}
