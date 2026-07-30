import { createQueuedAgentLifecycle, defineExpert, type McpManagedTool } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { createResolvedPiTools } from "../src/tools.ts";

describe("PI tool projection", () => {
  it("preserves human-readable labels for default and MCP tools", async () => {
    const expert = await defineExpert({
      id: "pi-tool-labels",
      name: "PI tool labels",
      description: "PI tool projection test",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
    });
    const mcpTool: McpManagedTool = {
      serverId: "docs-server",
      serverName: "Documentation",
      name: "search",
      description: "Search documentation.",
      inputSchema: { type: "object" },
      async call() {
        return { content: [] };
      },
    };

    const resolved = createResolvedPiTools({
      agent: expert,
      cwd: process.cwd(),
      mcpTools: [mcpTool],
      parentSystemPrompt: "",
      streamState: {},
      lifecycle: createQueuedAgentLifecycle(undefined),
    });

    expect(resolved.tools.find((tool) => tool.name === "list_expert_context")?.tool.label).toBe(
      "List expert context",
    );
    expect(resolved.tools.find((tool) => tool.source === "mcp")?.tool).toMatchObject({
      name: "mcp_docs_server_search",
      label: "MCP Documentation:search",
    });
  });
});
