import type { Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  createAgentLauncher,
  createQueuedAgentLifecycle,
  defineExpert,
  type McpManagedTool,
} from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createResolvedPiTools } from "../src/tools.ts";

describe("PI tool projection", () => {
  it("keeps lifecycle details for the Host and a single actionable model content", async () => {
    const member = await defineExpert({
      id: "worker",
      name: "Worker",
      description: "Worker",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
    });
    const agent = await defineExpert({
      id: "lead",
      name: "Lead",
      description: "Lead",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
      tools: createAgentLauncher({ experts: [member] }).tools,
    });
    const resolved = createResolvedPiTools({
      agent,
      cwd: process.cwd(),
      mcpTools: [],
      parentSystemPrompt: "",
      streamState: {},
      lifecycle: createQueuedAgentLifecycle(undefined),
      executionContext: {
        executionId: "execution",
        invocationId: "root",
        depth: 0,
        spawnExpert: async () => ({
          expertId: "worker",
          agentId: "internal",
          contextId: "context",
          invocationId: "task",
          status: "queued",
        }),
      },
    });
    const tool = resolved.tools.find((tool) => tool.name === "spawn_expert")!.tool;
    const result = await tool.execute(
      "call",
      { expertId: "worker", task: "Review" },
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
    expect(result.details).toEqual(JSON.parse((result.content[0] as { text: string }).text));
    expect(result.content).toHaveLength(1);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      expertId: "worker",
      contextId: "context",
      invocationId: "task",
      status: "queued",
      message: expect.stringContaining("not a completion result"),
    });
    const model: Model<"openai-responses"> = {
      id: "fixture",
      name: "Fixture",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    };
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call",
      toolName: "spawn_expert",
      timestamp: 0,
      content: result.content,
      isError: false,
      details: JSON.parse(JSON.stringify(result.details)),
    };
    // Exercise the installed provider serializer, not just the Pragma projection.
    expect(
      convertResponsesMessages(
        model,
        normalizeContext({ messages: [message] }),
        new Set(["openai"]),
      ),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "call",
        output: (result.content[0] as { text: string }).text,
      },
    ]);
  });

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

  it("sends MCP images as native provider image inputs and degrades unsupported blocks at the Pi boundary", async () => {
    const agent = await defineExpert({
      id: "image-tools",
      name: "Image tools",
      description: "Test",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
    });
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==",
    };
    const resource = {
      type: "resource",
      resource: { uri: "file:///notes.txt", text: "Additional notes" },
    };
    const warn = vi.spyOn(agent.logger, "warn");
    const resolved = createResolvedPiTools({
      agent,
      cwd: process.cwd(),
      parentSystemPrompt: "",
      streamState: {},
      lifecycle: createQueuedAgentLifecycle(undefined),
      mcpTools: [
        {
          serverId: "fixture",
          serverName: "Fixture",
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          call: async () => ({
            content: [{ type: "text", text: "Preview" }, image, resource],
            structuredContent: { value: 7 },
          }),
        },
      ],
    });
    const tool = resolved.tools.find((tool) => tool.source === "mcp")!.tool;
    const result = await tool.execute(
      "image-call",
      {},
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
    expect(result.content[1]).toEqual(image);
    expect(result.details).toEqual({ value: 7 });
    expect(result.content[2]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Additional notes"),
    });
    expect(warn).toHaveBeenCalledWith("runtime.tool_content_degraded", expect.any(String), {
      toolName: tool.name,
      contentType: "resource",
    });
    const model: Model<"openai-responses"> = {
      id: "fixture",
      name: "Fixture",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.invalid/v1",
      input: ["text", "image"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    };
    const request = convertResponsesMessages(
      model,
      normalizeContext({
        messages: [
          {
            role: "toolResult",
            toolCallId: "image-call",
            toolName: tool.name,
            timestamp: 0,
            isError: false,
            content: result.content,
            details: { privateMarker: "host-only" },
          },
        ],
      }),
      new Set(["openai"]),
    );
    expect(request).toEqual([
      {
        type: "function_call_output",
        call_id: "image-call",
        output: [
          { type: "input_text", text: expect.stringContaining("Preview") },
          { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${image.data}` },
        ],
      },
    ]);
    expect(JSON.stringify(request)).not.toContain("host-only");
    warn.mockRestore();
  });
});
