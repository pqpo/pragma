import { getToolResultText } from "../src/tools/managed-tool.ts";
import { describe, expect, it } from "vitest";

import {
  createTextToolResult,
  defineExpert,
  resolveExecutionTools,
  toModelToolResult,
} from "../src/index.ts";

const payload = { status: "queued", invocationId: "unique-task-marker" };
const json = JSON.stringify(payload);

describe("Tool result model boundary", () => {
  it.each([false, true])("excludes Host metadata, including on errors: %s", (isError) => {
    const result = createTextToolResult("Complete business result\n\nHost hint", {
      isError,
      details: { privateMarker: "host-only", stack: "private stack" },
    });
    expect(toModelToolResult(result)).toEqual({
      content: result.content,
      isError,
    });
    expect(JSON.stringify(toModelToolResult(result))).not.toContain("host-only");
    expect(result.details).toMatchObject({ privateMarker: "host-only" });
  });

  it.each([
    { name: "text only", response: { content: [{ type: "text", text: json }] }, text: json },
    { name: "structured only", response: { content: [], structuredContent: payload }, text: json },
    { name: "structured without content", response: { structuredContent: payload }, text: json },
    {
      name: "mirrored JSON",
      response: {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      },
      text: JSON.stringify(payload, null, 2),
    },
    {
      name: "summary plus structured business data",
      response: { content: [{ type: "text", text: "Task accepted" }], structuredContent: payload },
      text: `Task accepted\n${json}`,
    },
    {
      name: "error with structured diagnostics",
      response: { isError: true, content: [], structuredContent: payload },
      text: json,
    },
  ])("normalizes MCP $name without serializing its envelope", async ({ response, text }) => {
    const result = await callMcp({ ...response, _meta: { privateMarker: "host-only" } });
    expect(getToolResultText(result)).toBe(text);
    expect(result.details).toEqual(
      "structuredContent" in response
        ? payload
        : {
            ...response,
            _meta: { privateMarker: "host-only" },
          },
    );
    const model = toModelToolResult(result);
    expect(JSON.stringify(model)).not.toContain("host-only");
    expect(getToolResultText(result).match(/unique-task-marker/g)).toHaveLength(1);
    expect(model).not.toHaveProperty("structuredContent");
    expect(model).not.toHaveProperty("details");
    if ("isError" in response) expect(model.isError).toBe(true);
  });

  it("preserves resource identity and body without repeating mirrored structured data", async () => {
    const content = {
      type: "resource",
      resource: { uri: "file:///result.json", mimeType: "application/json", text: json },
    };
    const result = await callMcp({ content: [content], structuredContent: payload });
    expect(result.content).toEqual([content]);
    expect(toModelToolResult(result)).toEqual({ content: [content] });
    expect(JSON.parse(getToolResultText(result))).toEqual(content);
    expect(getToolResultText(result).match(/unique-task-marker/g)).toHaveLength(1);
    expect(result.details).toEqual(payload);
  });

  it.each([null, false, 0, "", [], [1, 2]])("preserves structured JSON value %j", async (value) => {
    const result = await callMcp({ content: [], structuredContent: value });
    expect(result.details).toEqual(value);
    expect(toModelToolResult(result)).toEqual({
      content: [{ type: "text", text: JSON.stringify(value) }],
    });
  });

  it("retains in-process MCP error details without nesting another protocol envelope", async () => {
    const details = { code: "invalid_input", service: "Calculator", tool: "add" };
    const result = await callMcp({
      content: [{ type: "text", text: "Missing required input: left" }],
      isError: true,
      details,
    });
    expect(result.details).toEqual(details);
    expect(toModelToolResult(result)).toEqual({
      content: [{ type: "text", text: "Missing required input: left" }],
      isError: true,
    });
  });

  it("preserves audio, resource links, annotations and extension metadata as native blocks", async () => {
    const content = [
      {
        type: "audio",
        data: "audio-bytes",
        mimeType: "audio/wav",
        annotations: { audience: ["assistant"], priority: 0.8 },
      },
      {
        type: "resource_link",
        uri: "file:///report.pdf",
        name: "Report",
        mimeType: "application/pdf",
        _meta: { source: "fixture" },
      },
    ];
    const result = await callMcp({ content });
    expect(toModelToolResult(result)).toEqual({ content });
  });

  it("preserves mixed text, image, and resource content with distinct structured data", async () => {
    const image = { type: "image", mimeType: "image/png", data: "image-bytes" };
    const resource = {
      type: "resource",
      resource: { uri: "file:///notes.txt", text: "Additional notes" },
    };
    const result = await callMcp({
      content: [{ type: "text", text: "Summary" }, image, resource],
      structuredContent: payload,
    });
    expect(result.content).toEqual([
      { type: "text", text: "Summary" },
      image,
      resource,
      { type: "text", text: json },
    ]);
    expect(toModelToolResult(result).content).toEqual(result.content);
    const lines = getToolResultText(result).split("\n");
    expect(lines[0]).toBe("Summary");
    expect(JSON.parse(lines[1]!)).toEqual(image);
    expect(JSON.parse(lines[2]!)).toEqual(resource);
    expect(JSON.parse(lines[3]!)).toEqual(payload);
  });
});

async function callMcp(response: unknown) {
  const agent = await defineExpert({
    id: "tool-projection",
    name: "Tool projection",
    description: "Test",
    tags: [],
    scope: "test",
    workspace: process.cwd(),
  });
  const resolved = resolveExecutionTools({
    agent,
    getContext: () => undefined,
    mcpTools: [
      {
        serverId: "fixture",
        serverName: "Fixture",
        name: "read",
        description: "Read fixture",
        inputSchema: { type: "object" },
        call: async () => response,
      },
    ],
  });
  return await resolved.tools.find((tool) => tool.source === "mcp")!.tool.call({}, undefined);
}
