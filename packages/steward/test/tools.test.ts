import { describe, expect, it } from "vitest";

import type { StewardDslProjectPort, StewardTaskPort } from "../src/ports.ts";
import { createStewardTools } from "../src/tools.ts";

describe("Steward managed tools", () => {
  it("keeps read tools open and gates durable writes", async () => {
    const tools = createStewardTools({ project: projectPort(), tasks: taskPort() });
    expect(tools.find((tool) => tool.name === "list_dsl_resources")?.approval).toBeUndefined();
    expect(tools.find((tool) => tool.name === "commit_dsl_changes")?.approval?.mode).toBe(
      "required",
    );
    expect(tools.find((tool) => tool.name === "submit_task")?.approval?.mode).toBe("required");
    expect(tools.find((tool) => tool.name === "interrupt_task")?.approval).toBeUndefined();
  });

  it("injects the runtime toolCallId as the write operation id", async () => {
    let operationId = "";
    const project = projectPort({
      async commit(input) {
        operationId = input.operationId;
        return { projectId: "studio", projectRevision: 2, changedRefs: [] };
      },
    });
    const tool = createStewardTools({ project, tasks: taskPort() }).find(
      (candidate) => candidate.name === "commit_dsl_changes",
    )!;
    await tool.call({ changeSetId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b" }, undefined, {
      toolCallId: "runtime-call-7",
    });
    expect(operationId).toBe("runtime-call-7");
  });
});

function projectPort(overrides: Partial<StewardDslProjectPort> = {}): StewardDslProjectPort {
  return {
    list: async () => ({ projectRevision: 0, resources: [] }),
    read: async () => {
      throw new Error("unused");
    },
    prepare: async () => {
      throw new Error("unused");
    },
    getChangeSet: async () => {
      throw new Error("unused");
    },
    commit: async () => ({ projectId: "studio", projectRevision: 1, changedRefs: [] }),
    ...overrides,
  };
}

function taskPort(): StewardTaskPort {
  return {
    list: async () => [],
    get: async () => {
      throw new Error("unused");
    },
    submit: async () => {
      throw new Error("unused");
    },
    sendMessage: async () => {
      throw new Error("unused");
    },
    listWorkItems: async () => [],
    interrupt: async () => {
      throw new Error("unused");
    },
  };
}
