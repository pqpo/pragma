import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { appendCodexExecutionMcpConfig } from "../src/execution-mcp-config.ts";

describe("Codex Execution MCP config", () => {
  it("passes the isolated registration id and URL to app-server", () => {
    expect(
      appendCodexExecutionMcpConfig(["app-server", "--listen", "stdio://"], {
        id: "pragma",
        url: "http://127.0.0.1:43127/sessions/opaque-token/mcp",
      }),
    ).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'mcp_servers.pragma.url="http://127.0.0.1:43127/sessions/opaque-token/mcp"',
      "-c",
      "mcp_servers.pragma.enabled=true",
      "-c",
      "mcp_servers.pragma.required=true",
      "-c",
      'mcp_servers.pragma.default_tools_approval_mode="approve"',
    ]);
  });

  it("forces the current workspace to remain untrusted", () => {
    expect(
      appendCodexExecutionMcpConfig(
        ["app-server", "--listen", "stdio://"],
        {
          id: "pragma",
          url: "http://127.0.0.1:43127/sessions/opaque-token/mcp",
        },
        "/workspace/project",
      ),
    ).toEqual(
      expect.arrayContaining([
        "-c",
        `projects.${JSON.stringify(resolve("/workspace/project"))}.trust_level="untrusted"`,
      ]),
    );
  });
});
