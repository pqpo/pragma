import { describe, expect, it } from "vitest";

import { appendCodexExecutionMcpConfig } from "../src/execution-mcp-config.ts";

describe("Codex Execution MCP config", () => {
  it("passes the isolated registration id and URL to app-server", () => {
    expect(
      appendCodexExecutionMcpConfig(["app-server", "--listen", "stdio://"], {
        id: "pragma_tools_expert_system_session",
        url: "http://127.0.0.1:43127/sessions/opaque-token/mcp",
      }),
    ).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'mcp_servers.pragma_tools_expert_system_session.url="http://127.0.0.1:43127/sessions/opaque-token/mcp"',
      "-c",
      "mcp_servers.pragma_tools_expert_system_session.enabled=true",
      "-c",
      "mcp_servers.pragma_tools_expert_system_session.required=true",
      "-c",
      'mcp_servers.pragma_tools_expert_system_session.default_tools_approval_mode="approve"',
    ]);
  });
});
