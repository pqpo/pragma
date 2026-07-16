import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  createExpertAgentLogger,
  defineExpert,
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
      registerTestSession("alpha", "system-session-alpha"),
      registerTestSession("beta", "system-session-beta"),
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
    await expect(betaClient.callTool({ name: "read_beta", arguments: {} })).resolves.toMatchObject({
      content: [{ type: "text", text: "beta" }],
    });
    const failedResult = await alphaClient.callTool({ name: "fail_alpha", arguments: {} });
    expect(failedResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "alpha failed" }],
    });
    expect(failedResult).not.toHaveProperty("structuredContent");

    const unknownTokenUrl = new URL(`/sessions/${"A".repeat(43)}/mcp`, alphaUrl.origin);
    await expect(fetch(unknownTokenUrl)).resolves.toMatchObject({ status: 404 });
  });

  it("revokes one Session without affecting others and stops when idle", async () => {
    const first = await registerTestSession("first", "system-session-first");
    const second = await registerTestSession("second", "system-session-second");
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

    const restarted = await registerTestSession("restarted", "system-session-restarted");
    const restartedClient = await connectClient(restarted.url, "restarted-client");
    await expect(
      restartedClient.callTool({ name: "read_restarted", arguments: {} }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "restarted" }] });
  });

  it("serializes concurrent registrations onto one listener", async () => {
    const concurrent = await Promise.all(
      Array.from(
        { length: 8 },
        async (_value, index) =>
          await registerTestSession(`concurrent_${index}`, `system-session-${index}`),
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
    const first = await registerTestSession("restore", "system-session-1");
    const firstId = first.id;
    const firstUrl = first.url;
    await first.dispose();
    registrations.delete(first);

    const restored = await registerTestSession("restore", "system-session-1");

    expect(restored.id).toBe(firstId);
    expect(restored.url).not.toBe(firstUrl);
  });
});

async function registerTestSession(
  label: string,
  instanceId: string,
): Promise<ExpertToolsMcpSessionRegistration> {
  const expert = await defineExpert({
    id: `runtime-${label}`,
    name: `Runtime ${label}`,
    description: "MCP Gateway test",
    tags: [],
    version: "1.0.0",
    scope: "test",
    workspace: process.cwd(),
    tools: [
      {
        name: `read_${label}`,
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
    ],
  });
  const registration = await registerExpertToolsMcpSession({
    agent: expert,
    instanceId,
    getContext: () => undefined,
    logger: createExpertAgentLogger(undefined, {
      component: "runtime-adapter",
      agentId: expert.id,
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
