import { describe, expect, it } from "vitest";

import type {
  DefaultAgentAutomationPort,
  DefaultAgentDslProjectPort,
  DefaultAgentTaskPort,
} from "../src/ports.ts";
import { createDefaultAgentTools } from "../src/tools.ts";

describe("DefaultAgent managed tools", () => {
  it("keeps read tools open and gates durable writes", async () => {
    const tools = createDefaultAgentTools({ project: projectPort(), tasks: taskPort() });
    expect(tools.find((tool) => tool.name === "list_dsl_resources")?.approval).toBeUndefined();
    expect(tools.find((tool) => tool.name === "list_expert_options")?.approval).toBeUndefined();
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
    const tool = createDefaultAgentTools({ project, tasks: taskPort() }).find(
      (candidate) => candidate.name === "commit_dsl_changes",
    )!;
    await tool.call({ changeSetId: "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b" }, undefined, {
      toolCallId: "runtime-call-7",
    });
    expect(operationId).toBe("runtime-call-7");
  });

  it("exposes approved Automation maintenance tools when the host supplies the port", async () => {
    let operationId = "";
    const automations = automationPort({
      async resetSession(input) {
        operationId = input.operationId;
        return automationSummary();
      },
    });
    const tools = createDefaultAgentTools({
      project: projectPort(),
      tasks: taskPort(),
      automations,
    });

    expect(tools.find((tool) => tool.name === "list_automations")?.approval).toBeUndefined();
    expect(tools.find((tool) => tool.name === "save_automation")?.approval?.mode).toBe("required");
    expect(tools.find((tool) => tool.name === "delete_automation")?.approval?.mode).toBe(
      "required",
    );
    const reset = tools.find((tool) => tool.name === "reset_automation_session")!;
    await reset.call({ ref: "automation:daily_review@1.0.0" }, undefined, {
      toolCallId: "runtime-call-reset",
    });
    expect(operationId).toBe("runtime-call-reset");
  });
});

function projectPort(
  overrides: Partial<DefaultAgentDslProjectPort> = {},
): DefaultAgentDslProjectPort {
  return {
    list: async () => ({ projectRevision: 0, resources: [] }),
    listExpertOptions: async () => ({ runtimeModels: [], capabilities: [] }),
    read: async () => {
      throw new Error("unused");
    },
    prepare: async () => {
      throw new Error("unused");
    },
    createFlowDraft: async () => {
      throw new Error("unused");
    },
    getFlowDraft: async () => {
      throw new Error("unused");
    },
    updateFlowDraft: async () => {
      throw new Error("unused");
    },
    validateFlowDraft: async () => {
      throw new Error("unused");
    },
    prepareFlowDraft: async () => {
      throw new Error("unused");
    },
    discardFlowDraft: async () => undefined,
    getChangeSet: async () => {
      throw new Error("unused");
    },
    commit: async () => ({ projectId: "studio", projectRevision: 1, changedRefs: [] }),
    ...overrides,
  };
}

function taskPort(): DefaultAgentTaskPort {
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

function automationPort(
  overrides: Partial<DefaultAgentAutomationPort> = {},
): DefaultAgentAutomationPort {
  return {
    list: async () => ({ projectRevision: 1, automations: [] }),
    save: async () => automationSummary(),
    delete: async (input) => ({ deleted: true, ref: input.ref }),
    resetSession: async () => automationSummary(),
    ...overrides,
  };
}

function automationSummary() {
  return {
    ref: "automation:daily_review@1.0.0",
    name: "Daily review",
    enabled: true,
    status: "scheduled" as const,
    executorRef: "expert:reviewer@1.0.0",
    interaction: "reuse-session" as const,
    workspaceId: "/work/review",
    nextRunAt: "2026-07-24T01:00:00.000Z",
    queueDepth: 0,
  };
}
