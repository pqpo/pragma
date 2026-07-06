import { describe, expect, it } from "vitest";

import {
  MemorySystem,
  createFactMemoryTools,
  createInMemoryFactMemoryStore,
} from "../src/index.ts";

describe("fact-memory tools", () => {
  it("writes and lists fact memory through tools", async () => {
    const memorySystem = new MemorySystem({
      factStore: createInMemoryFactMemoryStore(),
    });
    const tools = createFactMemoryTools({
      memorySystem,
      defaultAgentId: "code-search-agent",
    });
    const writeTool = tools.find((tool) => tool.name === "write_fact_memory");
    const listTool = tools.find((tool) => tool.name === "list_fact_memory");

    const writeResult = await writeTool?.call(
      {
        scope: "workspace",
        statement: "@pragma/core loop code lives under packages/core/src/loop.",
        confidence: "high",
        observedAt: "2026-07-06T00:00:00.000Z",
        tags: ["codebase"],
      },
      undefined,
      {
        runContext: {
          source: {
            type: "workflow",
            id: "code-search-agent",
          },
          attributes: {
            "execution.workflowRunId": "workflow-1",
          },
        },
      },
    );

    expect(writeResult?.text).toContain("Wrote fact memory:");

    const listResult = await listTool?.call(
      {
        scope: "workspace",
        confidenceAtLeast: "high",
        onlyActive: true,
        tags: ["codebase"],
      },
      undefined,
    );

    expect(listResult?.details).toEqual({
      entries: [
        expect.objectContaining({
          statement: "@pragma/core loop code lives under packages/core/src/loop.",
        }),
      ],
    });
  });
});
