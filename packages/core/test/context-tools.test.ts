import { describe, expect, it, vi } from "vitest";

import {
  createContextTools,
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  EXECUTION_ID_ATTR,
  INVOCATION_ID_ATTR,
  type ExpertAgentContextItemOperations,
} from "../src/index.ts";

describe("Expert context tools", () => {
  it("overlays the active submission identity onto a reused Runtime context", async () => {
    const listContext = vi.fn(async () => ({
      ok: true as const,
      value: { items: [], issues: [] },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error("not used");
    });
    const operations: ExpertAgentContextItemOperations = {
      listContext,
      readContext: unsupported,
      searchContext: unsupported,
      addContext: unsupported,
      editContext: unsupported,
      deleteContext: unsupported,
    };
    const tool = createContextTools(operations).find(
      (candidate) => candidate.name === "list_expert_context",
    );

    await tool!.call({}, undefined, {
      runContext: {
        source: { type: "expert-session", id: "session-1" },
        attributes: {
          [EXECUTION_ID_ATTR]: "execution-first",
          [INVOCATION_ID_ATTR]: "invocation-first",
          [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a",
        },
      },
      execution: {
        executionId: "execution-current",
        invocationId: "invocation-current",
        depth: 0,
      },
    });

    expect(listContext).toHaveBeenCalledWith({
      source: { type: "expert-session", id: "session-1" },
      attributes: {
        [EXECUTION_ID_ATTR]: "execution-current",
        [INVOCATION_ID_ATTR]: "invocation-current",
        [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a",
      },
    });
  });
});
