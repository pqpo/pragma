import { describe, expect, it } from "vitest";

import {
  ContextSystem,
  InMemoryContextStore,
  createContextTools,
  type ExpertAgentContextItemOperations,
} from "../src/index.ts";

describe("Host Context binding metadata", () => {
  it("supports always-on-only mutation approval and keeps unknown namespaces protected", async () => {
    const tools = createContextTools({} as ExpertAgentContextItemOperations, {
      mutationApprovalFor: (namespace) => {
        if (namespace === "mission-board") return "always_on_required";
        if (namespace === "scratch") return "none";
        return "required";
      },
    });
    const add = tools.find((tool) => tool.name === "add_expert_context");
    const edit = tools.find((tool) => tool.name === "edit_expert_context");
    const remove = tools.find((tool) => tool.name === "delete_expert_context");
    const request = (toolName: string, input: unknown) => ({
      kind: "tool_approval" as const,
      toolName,
      input,
    });

    expect(
      await add!.approval!.when!(
        request("add_expert_context", {
          namespace: "mission-board",
          id: "plan.md",
          content: "plan",
        }),
      ),
    ).toBe(false);
    expect(
      await add!.approval!.when!(
        request("add_expert_context", {
          namespace: "mission-board",
          id: "plan.md",
          content: "plan",
          trigger: "model_decision",
        }),
      ),
    ).toBe(false);
    expect(
      await add!.approval!.when!(
        request("add_expert_context", {
          namespace: "mission-board",
          id: "policy.md",
          content: "policy",
          trigger: "always_on",
        }),
      ),
    ).toBe(true);
    expect(
      await edit!.approval!.when!(
        request("edit_expert_context", {
          namespace: "mission-board",
          id: "plan.md",
          mode: "replace",
          content: "plan",
          trigger: "always_on",
        }),
      ),
    ).toBe(true);
    expect(
      await edit!.approval!.when!(
        request("edit_expert_context", {
          namespace: "mission-board",
          id: "plan.md",
          mode: "search_replace",
          search: "old",
          replace: "new",
        }),
      ),
    ).toBe(false);
    expect(
      await remove!.approval!.when!(
        request("delete_expert_context", { namespace: "mission-board", id: "plan.md" }),
      ),
    ).toBe(false);
    expect(
      await add!.approval!.when!(
        request("add_expert_context", {
          namespace: "scratch",
          id: "note.md",
          content: "note",
          trigger: "always_on",
        }),
      ),
    ).toBe(false);
    expect(
      await add!.approval!.when!(
        request("add_expert_context", { namespace: "memory", id: "fact.md", content: "fact" }),
      ),
    ).toBe(true);
    expect(await add!.approval!.when!(request("add_expert_context", null))).toBe(true);
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

  it("indexes Store display metadata", async () => {
    const system = new ContextSystem();
    system.register({
      namespace: "4jtrtegfka94yzgg",
      storeName: "Memory · 00pragma",
      store: new InMemoryContextStore({
        context: [
          {
            id: "guide.md",
            content: "Treat this as the preferred name.",
          },
        ],
      }),
    });

    await expect(system.index()).resolves.toMatchObject({
      ok: true,
      value: {
        stores: [{ namespace: "4jtrtegfka94yzgg", storeName: "Memory · 00pragma", itemCount: 1 }],
        items: [{ id: "guide.md", revision: expect.any(String) }],
      },
    });
  });
});
