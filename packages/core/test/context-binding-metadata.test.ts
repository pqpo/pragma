import { describe, expect, it } from "vitest";

import {
  ContextSystem,
  InMemoryContextStore,
  createContextTools,
  type ExpertAgentContextItemOperations,
} from "../src/index.ts";

describe("Host Context binding metadata", () => {
  it("selects mutation approval by namespace and keeps unknown namespaces protected", async () => {
    const tools = createContextTools({} as ExpertAgentContextItemOperations, {
      mutationApprovalFor: (namespace) => (namespace === "mission-board" ? "none" : "required"),
    });
    const add = tools.find((tool) => tool.name === "add_expert_context");
    expect(add?.approval?.when).toBeDefined();
    const request = (namespace: string) => ({
      kind: "tool_approval" as const,
      toolName: "add_expert_context",
      input: { namespace, id: "plan.md", content: "plan" },
    });
    expect(await add!.approval!.when!(request("mission-board"))).toBe(false);
    expect(await add!.approval!.when!(request("memory"))).toBe(true);
    expect(await add!.approval!.when!({ ...request("memory"), input: null })).toBe(true);
  });

  it("allows exactly one generic overflow target", () => {
    const system = new ContextSystem();
    expect(
      system.register({
        namespace: "mission-board",
        store: new InMemoryContextStore(),
        overflowTarget: true,
      }).ok,
    ).toBe(true);
    const duplicate = system.register({
      namespace: "another-board",
      store: new InMemoryContextStore(),
      overflowTarget: true,
    });
    expect(duplicate.ok ? undefined : duplicate.error.code).toBe("invalid_input");
    expect(system.overflowTargetNamespace).toBe("mission-board");
  });
});
