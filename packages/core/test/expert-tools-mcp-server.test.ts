import { createTextToolResult } from "../src/tools/managed-tool.ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPragmaLogger,
  createAgentLauncher,
  defineExpert,
  HumanInteractionCheckpointError,
  registerExpertToolsMcpSession,
  type ExpertToolsMcpSessionRegistration,
} from "../src/index.ts";

const registrations = new Set<ExpertToolsMcpSessionRegistration>();
const clients = new Set<Client>();

describe("Expert tools MCP Gateway", { concurrent: false }, () => {
  afterEach(async () => {
    await Promise.allSettled([...clients].map(async (client) => await client.close()));
    clients.clear();
    await Promise.allSettled(
      [...registrations].map(async (registration) => await registration.dispose()),
    );
    registrations.clear();
  });

  it.each([
    ["ask", "expert"],
    ["required", "expert"],
    ["ask", "tool"],
    ["required", "tool"],
  ] as const)(
    "serves lifecycle tools without %s approvals from %s, Host details or duplicate structuredContent",
    async (mode, source) => {
      const worker = await defineExpert({
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
        tools: createAgentLauncher({ experts: [worker] }).tools.map((tool) =>
          source === "tool" ? { ...tool, approval: { mode } } : tool,
        ),
        executionToolApprovals:
          source === "tool"
            ? undefined
            : Object.fromEntries(
                [
                  "spawn_expert",
                  "continue_expert",
                  "wait_experts",
                  "list_agents",
                  "steer_expert",
                  "interrupt_expert",
                ].map((name) => [name, { mode }]),
              ),
      });
      const approvalHandler = vi.fn(async () => ({
        kind: "tool_approval" as const,
        approved: false,
      }));
      const identity = { agentId: "internal", contextId: "context", invocationId: "task" };
      const registration = await registerExpertToolsMcpSession({
        agent,
        humanInteractionHandler: approvalHandler,
        getContext: () => undefined,
        logger: createPragmaLogger(undefined, { component: "test" }),
        state: {},
        executionContext: {
          executionId: "execution",
          invocationId: "root",
          depth: 0,
          spawnExpert: async () => ({ ...identity, expertId: "worker", status: "queued" }),
          continueExpert: async () => ({
            ...identity,
            invocationId: "next",
            status: "queued",
            agentDisposition: "reused",
          }),
          waitExperts: async () => ({
            returnWhen: "all",
            timedOut: false,
            waitedMs: 7,
            completed: [{ ...identity, status: "succeeded", output: "Review done" }],
            pending: [],
          }),
          listAgents: async () => ({
            availableExperts: [{ expertId: "worker", canSpawn: true }],
            contexts: [{ ...identity, canContinue: true }],
          }),
          steerExpert: async () => ({
            ...identity,
            outcome: "accepted",
            delivery: "after_current",
            messageId: "guidance",
          }),
          interruptExpert: async () => ({ ...identity, outcome: "already_terminal" }),
        },
      });
      registrations.add(registration);
      const client = await connectClient(registration.url, "lifecycle");
      for (const [name, args] of [
        ["spawn_expert", { expertId: "worker", task: "Review" }],
        ["continue_expert", { contextId: "context", task: "Follow up" }],
        ["wait_experts", { invocationIds: ["task"] }],
        ["list_agents", {}],
        ["steer_expert", { invocationId: "task", instruction: "Focus", delivery: "after_current" }],
        ["interrupt_expert", { invocationId: "task" }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result).not.toHaveProperty("structuredContent");
        expect(result).not.toHaveProperty("details");
        const payload = JSON.parse((result.content[0] as { text: string }).text);
        expect(payload.message).toEqual(expect.any(String));
        expect(payload).not.toHaveProperty("agentId");
        if (name === "wait_experts") expect(payload.completed[0].output).toBe("Review done");
      }
      expect(approvalHandler).not.toHaveBeenCalled();
      const other = await registerTestSession("structured");
      const otherClient = await connectClient(other.url, "structured");
      const otherResult = await otherClient.callTool({ name: "read_structured", arguments: {} });
      expect(otherResult).toMatchObject({ content: [{ type: "text", text: "structured" }] });
      expect(otherResult).not.toHaveProperty("structuredContent");
      expect(otherResult).not.toHaveProperty("details");
    },
  );

  it("shares one listener while isolating Session tools and routes", async () => {
    const [alpha, beta] = await Promise.all([
      registerTestSession("alpha"),
      registerTestSession("beta"),
    ]);
    const alphaUrl = new URL(alpha.url);
    const betaUrl = new URL(beta.url);

    expect(alphaUrl.origin).toBe(betaUrl.origin);
    expect(alphaUrl.pathname).not.toBe(betaUrl.pathname);
    expect(alphaUrl.pathname).toMatch(/^\/sessions\/[A-Za-z0-9_-]{43}\/mcp$/);

    const [alphaClient, betaClient] = await Promise.all([
      connectClient(alpha.url, "alpha-client"),
      connectClient(beta.url, "beta-client"),
    ]);
    const [alphaTools, betaTools] = await Promise.all([
      alphaClient.listTools(),
      betaClient.listTools(),
    ]);

    expect(alpha.toolCatalog.map((tool) => tool.name)).toEqual(
      alphaTools.tools.map((tool) => tool.name),
    );
    expect(alpha.toolCatalog.find((tool) => tool.name === "read_alpha")?.inputSchema).toEqual(
      alphaTools.tools.find((tool) => tool.name === "read_alpha")?.inputSchema,
    );
    expect(alphaTools.tools.map((tool) => tool.name)).toContain("read_alpha");
    expect(alphaTools.tools.map((tool) => tool.name)).toContain("list_expert_context");
    expect(alphaTools.tools.map((tool) => tool.name)).toContain("list_context_stores");
    const directory = await alphaClient.callTool({ name: "list_context_stores", arguments: {} });
    expect(directory.isError).not.toBe(true);
    expect(directory.content).toHaveLength(1);
    expect(JSON.parse((directory.content[0] as { text: string }).text)).toHaveProperty("stores");
    const badWrite = await alphaClient.callTool({
      name: "add_expert_context",
      arguments: { namespace: "unregistered", id: "guide.md", content: "Must not write" },
    });
    expect(badWrite.isError).toBe(true);
    expect(JSON.parse((badWrite.content[0] as { text: string }).text)).toMatchObject({
      error: { code: "invalid_namespace" },
      recovery: { tool: "list_context_stores", arguments: {} },
    });
    expect(alphaTools.tools.map((tool) => tool.name)).not.toContain("read_beta");
    expect(betaTools.tools.map((tool) => tool.name)).toContain("read_beta");
    expect(betaTools.tools.map((tool) => tool.name)).not.toContain("read_alpha");
    expect(alphaTools.tools.find((tool) => tool.name === "read_alpha")).not.toHaveProperty(
      "outputSchema",
    );

    await expect(
      alphaClient.callTool({ name: "read_alpha", arguments: {} }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "alpha" }] });
    const contextResult = await alphaClient.callTool({
      name: "list_expert_context",
      arguments: { namespace: " ", cursor: "  " },
    });
    expect(contextResult).not.toMatchObject({ isError: true });
    expect(contextResult).not.toHaveProperty("structuredContent");
    expect(contextResult).not.toHaveProperty("details");
    expect(contextResult.content).toHaveLength(1);
    expect(contextResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Expert context items"),
    });
    await expect(
      alphaClient.callTool({
        name: "read_expert_context",
        arguments: { namespace: "alpha", id: "   " },
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(betaClient.callTool({ name: "read_beta", arguments: {} })).resolves.toMatchObject({
      content: [{ type: "text", text: "beta" }],
    });
    const failedResult = await alphaClient.callTool({ name: "fail_alpha", arguments: {} });
    expect(failedResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "alpha failed" }],
    });
    expect(failedResult).not.toHaveProperty("structuredContent");
    const thrownResult = await alphaClient.callTool({ name: "throw_alpha", arguments: {} });
    expect(thrownResult).toMatchObject({ isError: true });
    expect(thrownResult).not.toHaveProperty("structuredContent");
    expect(JSON.parse((thrownResult.content[0] as { text: string }).text)).toEqual({
      ok: false,
      committed: false,
      error: { code: "tool_execution_failed", message: "alpha exploded" },
    });

    const unknownTokenUrl = new URL(`/sessions/${"A".repeat(43)}/mcp`, alphaUrl.origin);
    await expect(fetch(unknownTokenUrl)).resolves.toMatchObject({ status: 404 });
  });

  it("validates output inside the Host without exposing schemas or metadata to the model", async () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    };
    const agent = await defineExpert({
      id: "validated",
      name: "Validated",
      description: "Test",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
      tools: [
        {
          name: "valid",
          description: "Valid",
          inputSchema: { type: "object" },
          outputSchema: schema,
          call: async () =>
            createTextToolResult('{"value":"visible"}', {
              details: { value: "visible", privateMarker: "host-only" },
            }),
        },
        {
          name: "invalid",
          description: "Invalid",
          inputSchema: { type: "object" },
          outputSchema: schema,
          call: async () =>
            createTextToolResult("Must not reach the model", { details: { value: 7 } }),
        },
        {
          name: "missing",
          description: "Missing",
          inputSchema: { type: "object" },
          outputSchema: schema,
          call: async () => createTextToolResult("Must not reach the model"),
        },
      ],
    });
    const registration = await registerExpertToolsMcpSession({
      agent,
      getContext: () => undefined,
      logger: createPragmaLogger(undefined, { component: "test" }),
      state: {},
    });
    registrations.add(registration);
    const client = await connectClient(registration.url, "validated");
    for (const tool of (await client.listTools()).tools)
      expect(tool).not.toHaveProperty("outputSchema");
    const valid = await client.callTool({ name: "valid", arguments: {} });
    expect(valid).toEqual({ content: [{ type: "text", text: '{"value":"visible"}' }] });
    expect(JSON.stringify(valid)).not.toContain("host-only");
    for (const name of ["invalid", "missing"]) {
      const invalid = await client.callTool({ name, arguments: {} });
      expect(invalid.isError).toBe(true);
      expect(JSON.parse((invalid.content[0] as { text: string }).text)).toMatchObject({
        ok: false,
        committed: false,
        error: {
          code: "tool_execution_failed",
          message: expect.stringContaining("Invalid output"),
        },
      });
      expect(invalid).not.toHaveProperty("structuredContent");
    }
  });

  it("forwards native MCP content blocks without flattening or repeating Host details", async () => {
    const content = [
      { type: "text", text: "Preview" },
      { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
      { type: "audio", data: "YXVkaW8tYnl0ZXM=", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///notes.txt", text: "Notes" } },
      { type: "resource_link", uri: "file:///report.pdf", name: "Report" },
    ];
    const agent = await defineExpert({
      id: "content-test",
      name: "Content",
      description: "Test",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
    });
    const registration = await registerExpertToolsMcpSession({
      agent,
      getContext: () => undefined,
      logger: createPragmaLogger(undefined, { component: "test" }),
      state: {},
      mcpTools: [
        {
          serverId: "fixture",
          serverName: "Fixture",
          name: "read",
          description: "Read",
          inputSchema: { type: "object" },
          call: async () => ({ content, _meta: { privateMarker: "host-only" } }),
        },
      ],
    });
    registrations.add(registration);
    const client = await connectClient(registration.url, "native-content");
    const result = await client.callTool({ name: "mcp_fixture_read", arguments: {} });
    expect(result).toEqual({ content });
    expect(JSON.stringify(result)).not.toContain("host-only");
  });

  it("serves independent clients and reconnects on one Session URL", async () => {
    const registration = await registerTestSession("shared");
    const first = await connectClient(registration.url, "shared-first");
    const second = await connectClient(registration.url, "shared-second");
    const results = await Promise.all(
      [first, second].map(
        async (client) => await client.callTool({ name: "read_shared", arguments: {} }),
      ),
    );
    for (const result of results) {
      expect(result).toMatchObject({ content: [{ type: "text", text: "shared" }] });
    }
    await first.close();
    clients.delete(first);
    const reconnected = await connectClient(registration.url, "shared-reconnected");
    await expect(
      reconnected.callTool({ name: "read_shared", arguments: {} }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "shared" }],
    });
  });

  it("revokes one Session without affecting others and stops when idle", async () => {
    const first = await registerTestSession("first");
    const second = await registerTestSession("second");
    const secondClient = await connectClient(second.url, "second-client");
    const origin = new URL(first.url).origin;

    await first.dispose();
    await first.dispose();
    registrations.delete(first);

    await expect(fetch(first.url)).resolves.toMatchObject({ status: 404 });
    await expect(
      secondClient.callTool({ name: "read_second", arguments: {} }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "second" }] });

    await secondClient.close();
    clients.delete(secondClient);
    await second.dispose();
    registrations.delete(second);

    await expect(fetch(origin)).rejects.toThrow();

    const restarted = await registerTestSession("restarted");
    const restartedClient = await connectClient(restarted.url, "restarted-client");
    await expect(
      restartedClient.callTool({ name: "read_restarted", arguments: {} }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "restarted" }] });
  });

  it("serializes concurrent registrations onto one listener", async () => {
    const concurrent = await Promise.all(
      Array.from(
        { length: 8 },
        async (_value, index) => await registerTestSession(`concurrent_${index}`),
      ),
    );

    expect(
      new Set(concurrent.map((registration) => new URL(registration.url).origin)),
    ).toHaveLength(1);
    expect(
      new Set(concurrent.map((registration) => new URL(registration.url).pathname)),
    ).toHaveLength(concurrent.length);
  });

  it("keeps the config id stable across restore while rotating the endpoint token", async () => {
    const first = await registerTestSession("restore");
    const firstId = first.id;
    const firstUrl = first.url;
    await first.dispose();
    registrations.delete(first);

    const restored = await registerTestSession("restore");

    expect(firstId).toBe("pragma");
    expect(restored.id).toBe("pragma");
    expect(restored.url).not.toBe(firstUrl);
  });

  it("exposes stable bounded names for long or unsafe tools", async () => {
    const originalName = `read-tool-${"x".repeat(80)}`;
    const first = await registerTestSession("bounded", originalName);
    const firstClient = await connectClient(first.url, "bounded-client");
    const firstName = (await firstClient.listTools()).tools.find((tool) =>
      tool.name.startsWith("read_tool_"),
    )?.name;
    expect(firstName).toBeDefined();
    expect(`mcp__pragma__${firstName}`).toHaveLength(64);
    await expect(firstClient.callTool({ name: firstName!, arguments: {} })).resolves.toMatchObject({
      content: [{ type: "text", text: "bounded" }],
    });

    await firstClient.close();
    clients.delete(firstClient);
    await first.dispose();
    registrations.delete(first);
    const restored = await registerTestSession("bounded", originalName);
    const restoredClient = await connectClient(restored.url, "bounded-restored-client");
    expect((await restoredClient.listTools()).tools.map((tool) => tool.name)).toContain(firstName);
  });

  it("uses the Runtime name budget for discovery, calls, and re-registration", async () => {
    const nativePrefix = "mcp_pragma-0123456789abcdef_p_";
    const budget = 64 - nativePrefix.length;
    const original = `read_${"x".repeat(80)}`;
    const names: string[] = [];
    for (let i = 0; i < 2; i++) {
      const registration = await registerTestSession("agy", original, budget);
      const client = await connectClient(registration.url, `agy-${i}`);
      const tools = (await client.listTools()).tools;
      expect(tools.every((tool) => /^[a-zA-Z0-9_-]{1,64}$/.test(nativePrefix + tool.name))).toBe(
        true,
      );
      const name = tools.find((tool) => tool.name.startsWith("read_x"))!.name;
      names.push(name);
      expect(nativePrefix + name).toHaveLength(64);
      await expect(client.callTool({ name, arguments: {} })).resolves.toMatchObject({
        content: [{ type: "text", text: "agy" }],
      });
      await expect(client.callTool({ name: original, arguments: {} })).rejects.toThrow(/not found/);
    }
    expect(names[0]).toBe(names[1]);
    await expect(registerTestSession("invalid_budget", original, 11)).rejects.toThrow(/name limit/);
  });

  it("removes only redundant constraints beside local JSON Schema references", async () => {
    const expert = await defineExpert({
      id: "runtime-schema-normalization",
      name: "Runtime schema normalization",
      description: "MCP Gateway schema normalization test",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
      tools: [
        {
          name: "recursive_schema",
          description: "Accept a recursive schema.",
          inputSchema: {
            type: "object",
            properties: {
              redundant: {
                oneOf: [{ type: "string" }, { type: "number" }],
                $ref: "#/$defs/value",
              },
              meaningful: {
                $ref: "#/$defs/value",
                description: "Keep this independent annotation.",
              },
            },
            $defs: {
              value: {
                oneOf: [{ type: "string" }, { type: "number" }],
              },
            },
          },
          async call() {
            return createTextToolResult("ok");
          },
        },
      ],
    });
    const registration = await registerExpertToolsMcpSession({
      agent: expert,
      getContext: () => undefined,
      logger: createPragmaLogger(undefined, {
        component: "runtime.adapter",
        scope: { agentId: expert.id },
      }),
      state: {},
    });
    registrations.add(registration);
    const client = await connectClient(registration.url, "schema-normalization-client");
    const schema = (await client.listTools()).tools.find(
      (tool) => tool.name === "recursive_schema",
    )?.inputSchema;

    expect(schema).toMatchObject({
      properties: {
        redundant: { $ref: "#/$defs/value" },
        meaningful: {
          $ref: "#/$defs/value",
          description: "Keep this independent annotation.",
        },
      },
      $defs: {
        value: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
    });
    expect(
      (schema as { properties?: { redundant?: unknown } }).properties?.redundant,
    ).not.toHaveProperty("oneOf");
  });

  it("keeps human checkpoints out of ordinary tool failure results", async () => {
    const expert = await defineExpert({
      id: "runtime-human-checkpoint",
      name: "Runtime human checkpoint",
      description: "MCP Gateway checkpoint control signal test",
      tags: [],
      scope: "test",
      workspace: process.cwd(),
      tools: [
        {
          name: "checkpoint",
          description: "Trigger a human checkpoint.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          async call() {
            throw new HumanInteractionCheckpointError("checkpoint-execution");
          },
        },
      ],
    });
    const registration = await registerExpertToolsMcpSession({
      agent: expert,
      getContext: () => undefined,
      logger: createPragmaLogger(undefined, {
        component: "runtime.adapter",
        scope: { agentId: expert.id },
      }),
      state: {},
    });
    registrations.add(registration);
    const client = await connectClient(registration.url, "human-checkpoint-client");

    const result = await client.callTool({ name: "checkpoint", arguments: {} });
    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "Execution checkpointed while waiting for human input: checkpoint-execution",
        },
      ],
    });
    expect((result.content[0] as { text: string }).text).not.toContain("tool_execution_failed");
  });
});

async function registerTestSession(
  label: string,
  toolName = `read_${label}`,
  maxToolNameLength?: number,
): Promise<ExpertToolsMcpSessionRegistration> {
  const expert = await defineExpert({
    id: `runtime-${label}`,
    name: `Runtime ${label}`,
    description: "MCP Gateway test",
    tags: [],
    scope: "test",
    workspace: process.cwd(),
    tools: [
      {
        name: toolName,
        description: `Read ${label}`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        async call() {
          return createTextToolResult(label, { details: { value: label } });
        },
      },
      {
        name: `fail_${label}`,
        description: `Fail ${label}`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        async call() {
          return createTextToolResult(`${label} failed`, {
            isError: true,
            details: { code: "expected_failure" },
          });
        },
      },
      {
        name: `throw_${label}`,
        description: `Throw ${label}`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async call() {
          throw new Error(`${label} exploded`);
        },
      },
    ],
  });
  const registration = await registerExpertToolsMcpSession({
    agent: expert,
    maxToolNameLength,
    getContext: () => undefined,
    logger: createPragmaLogger(undefined, {
      component: "runtime.adapter",
      scope: { agentId: expert.id },
    }),
    state: {},
  });
  registrations.add(registration);
  return registration;
}

async function connectClient(url: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.add(client);
  return client;
}
