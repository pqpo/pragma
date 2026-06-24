import { describe, expect, it, vi } from "vitest";

import { createContextTools } from "./context-tools.ts";
import type { ExpertAgentContextItemOperations } from "./context-tools.ts";

describe("createContextTools", () => {
  it("passes run context from the session instead of tool input", async () => {
    const sessionContext = {
      source: {
        type: "session",
        id: "session-1",
      },
      attributes: {
        tenantId: "tenant-1",
      },
    };
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: [],
    }));
    const tools = createContextTools(
      {
        listContext,
        readContext: notCalledOperation,
        searchContext: notCalledOperation,
        addContext: notCalledOperation,
        updateContext: notCalledOperation,
        deleteContext: notCalledOperation,
      },
      {
        getContext: () => sessionContext,
      },
    );
    const listTool = tools.find((tool) => tool.name === "list_expert_context");

    expect((listTool?.inputSchema as { properties: Record<string, unknown> }).properties).toEqual(
      {},
    );

    await listTool?.call(
      {
        source: {
          type: "tool-input",
          id: "ignored",
        },
        context: {
          tenantId: "ignored",
        },
      },
      undefined,
    );

    expect(listContext).toHaveBeenCalledWith(sessionContext);
  });

  it("creates a default run context when no session context provider is present", async () => {
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: [],
    }));
    const listTool = createContextTools({
      listContext,
      readContext: notCalledOperation,
      searchContext: notCalledOperation,
      addContext: notCalledOperation,
      updateContext: notCalledOperation,
      deleteContext: notCalledOperation,
    }).find((tool) => tool.name === "list_expert_context");

    await listTool?.call({}, undefined);

    expect(listContext).toHaveBeenCalledWith({
      source: {
        type: "system",
      },
      attributes: {},
    });
  });
});

const notCalledOperation = vi.fn(async () => {
  throw new Error("Unexpected context operation call.");
}) as unknown as ExpertAgentContextItemOperations["readContext"] &
  ExpertAgentContextItemOperations["searchContext"] &
  ExpertAgentContextItemOperations["addContext"] &
  ExpertAgentContextItemOperations["updateContext"] &
  ExpertAgentContextItemOperations["deleteContext"];
