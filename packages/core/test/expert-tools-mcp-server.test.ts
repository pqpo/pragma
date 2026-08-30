import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPragmaLogger,
  defineExpert,
  HumanInteractionCheckpointError,
  registerExpertToolsMcpSession,
  type ExpertToolsMcpSessionRegistration,
} from "../src/index.ts";

const registrations = new Set<ExpertToolsMcpSessionRegistration>();
const clients = new Set<Client>();

describe.sequential("Expert tools MCP Gateway", () => {
  afterEach(async () => {
    await Promise.allSettled([...clients].map(async (client) => await client.close()));
    clients.clear();
    await Promise.allSettled(
      [...registrations].map(async (registration) => await registration.dispose()),
    );
    registrations.clear();
  });

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

    expect(alphaTools.tools.map((tool) => tool.name)).toContain("read_alpha");
    expect(alphaTools.tools.map((tool) => tool.name)).toContain("list_expert_context");
    expect(alphaTools.tools.map((tool) => tool.name)).not.toContain("read_beta");
    expect(betaTools.tools.map((tool) => tool.name)).toContain("read_beta");
    expect(betaTools.tools.map((tool) => tool.name)).not.toContain("read_alpha");
    expect(alphaTools.tools.find((tool) => tool.name === "read_alpha")?.outputSchema).toMatchObject(
      {
        type: "object",
        required: ["value"],
      },
    );

    await expect(
      alphaClient.callTool({ name: "read_alpha", arguments: {} }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "alpha" }] });
    await expect(
      alphaClient.callTool({
        name: "list_expert_context",
        arguments: { namespace: " ", cursor: "  " },
      }),
    ).resolves.not.toMatchObject({ isError: true });
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
            return { text: "ok" };
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
          return { text: label, details: { value: label } };
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
          return {
            text: `${label} failed`,
            isError: true,
            details: { code: "expected_failure" },
          };
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
