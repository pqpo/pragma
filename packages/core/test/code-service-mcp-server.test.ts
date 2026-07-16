import { describe, expect, it } from "vitest";

import { createCodeServiceMcpServer, verifyCodeServiceDefinition } from "../src/index.ts";

const definition = {
  name: "Calculator",
  timeoutMs: 250,
  tool: {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { left: { type: "number" }, right: { type: "number" } },
      required: ["left", "right"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { result: { type: "number" } },
      required: ["result"],
      additionalProperties: false,
    },
    source: "function main(input) { return { result: input.left + input.right }; }",
  },
};

describe("code service MCP server", () => {
  it("publishes both schemas and returns structured JSON", async () => {
    const server = createCodeServiceMcpServer(definition);

    await expect(server.listTools()).resolves.toEqual([
      expect.objectContaining({
        name: "add",
        inputSchema: definition.tool.inputSchema,
        outputSchema: definition.tool.outputSchema,
      }),
    ]);
    await expect(server.callTool("add", { left: 2, right: 3 })).resolves.toMatchObject({
      structuredContent: { result: 5 },
    });
  });

  it("validates input and output around execution", async () => {
    const server = createCodeServiceMcpServer({
      ...definition,
      tool: { ...definition.tool, source: "function main() { return { result: 'wrong' }; }" },
    });

    await expect(server.callTool("add", { left: 2 })).resolves.toMatchObject({
      isError: true,
      details: { code: "invalid_input" },
    });
    await expect(server.callTool("add", { left: 2, right: 3 })).resolves.toMatchObject({
      isError: true,
      details: { code: "invalid_output" },
    });
  });

  it("rejects host APIs, promises, and runaway execution", async () => {
    const hostAccess = createCodeServiceMcpServer({
      ...definition,
      tool: {
        ...definition.tool,
        source: "function main() { return { result: process.pid }; }",
      },
    });
    const promise = createCodeServiceMcpServer({
      ...definition,
      tool: {
        ...definition.tool,
        source: "function main() { return Promise.resolve({ result: 1 }); }",
      },
    });
    const runaway = createCodeServiceMcpServer({
      ...definition,
      timeoutMs: 25,
      tool: { ...definition.tool, source: "function main() { while (true) {} }" },
    });

    await expect(hostAccess.callTool("add", { left: 1, right: 1 })).resolves.toMatchObject({
      isError: true,
      details: { code: "runtime_error" },
    });
    await expect(promise.callTool("add", { left: 1, right: 1 })).resolves.toMatchObject({
      isError: true,
      details: { code: "invalid_output" },
    });
    await expect(runaway.callTool("add", { left: 1, right: 1 })).resolves.toMatchObject({
      isError: true,
      details: { code: "timeout" },
    });
  });

  it("hard-stops runaway code without blocking the host event loop", async () => {
    const runaway = createCodeServiceMcpServer({
      ...definition,
      timeoutMs: 250,
      tool: { ...definition.tool, source: "function main() { while (true) {} }" },
    });
    const execution = runaway.callTool("add", { left: 1, right: 1 });
    const first = await Promise.race([
      execution.then(() => "execution" as const),
      new Promise<"host-timer">((resolve) => setTimeout(() => resolve("host-timer"), 25)),
    ]);

    expect(first).toBe("host-timer");
    await expect(execution).resolves.toMatchObject({
      isError: true,
      details: { code: "timeout" },
    });
  });

  it("terminates isolated execution when the caller aborts", async () => {
    const controller = new AbortController();
    const runaway = createCodeServiceMcpServer({
      ...definition,
      timeoutMs: 5_000,
      tool: { ...definition.tool, source: "function main() { while (true) {} }" },
    });
    const execution = runaway.callTool("add", { left: 1, right: 1 }, controller.signal);
    setTimeout(() => controller.abort(), 25);

    await expect(execution).resolves.toMatchObject({
      isError: true,
      details: { code: "aborted" },
    });
  });

  it("verifies source without invoking main", async () => {
    await expect(verifyCodeServiceDefinition(definition)).resolves.toMatchObject({ ok: true });
    await expect(
      verifyCodeServiceDefinition({
        ...definition,
        tool: { ...definition.tool, source: "const nope = true;" },
      }),
    ).resolves.toMatchObject({ ok: false, code: "compile_error" });
  });
});
