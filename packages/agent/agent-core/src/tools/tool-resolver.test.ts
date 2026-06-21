import { describe, expect, it } from "vitest";

import {
  createToolPolicy,
  resolveToolPolicy,
  selectResolvedTools,
} from "./tool-resolver.ts";

describe("ToolPolicyResolver", () => {
  const tools = [
    { name: "read", source: "default" as const, tool: { name: "read" } },
    { name: "write", source: "managed" as const, tool: { name: "write" } },
    { name: "mcp_search", source: "mcp" as const, tool: { name: "mcp_search" } },
  ];

  it("applies run-level allow and deny policy before runtime launch", () => {
    const resolved = resolveToolPolicy({
      tools,
      context: {
        attributes: {
          toolPolicy: {
            allowedTools: ["read", "write"],
            deniedTools: ["write"],
          },
        },
      },
    });

    expect(resolved.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("selects subagent tools only from the parent resolved tool set", () => {
    const parent = resolveToolPolicy({
      tools,
      policy: {
        mode: "all",
        deniedTools: ["write"],
      },
    });

    expect(
      selectResolvedTools(
        parent,
        createToolPolicy({
          tools: ["write", "mcp_search", "unknown_tool"],
        }),
      ).tools.map((tool) => tool.name),
    ).toEqual(["mcp_search"]);
  });

  it("treats undefined and wildcard subagent tools as inherited resolved tools", () => {
    const parent = resolveToolPolicy({ tools });

    expect(selectResolvedTools(parent, createToolPolicy({})).tools).toEqual(parent.tools);
    expect(selectResolvedTools(parent, createToolPolicy({ tools: "*" })).tools).toEqual(
      parent.tools,
    );
  });
});
