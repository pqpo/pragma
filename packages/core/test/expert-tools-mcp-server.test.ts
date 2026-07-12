import { describe, expect, it } from "vitest";

import { createExpertAgentLogger, createExpertToolsMcpServer, defineExpert } from "../src/index.ts";

describe("Expert tools MCP server identity", () => {
  it("keeps the config id stable when a runtime session is restored", async () => {
    const expert = await defineExpert({
      id: "runtime-chat",
      name: "Runtime Chat",
      description: "MCP identity test",
      tags: [],
      version: "1.0.0",
      scope: "test",
      workspace: process.cwd(),
    });
    const logger = createExpertAgentLogger(undefined, {
      component: "runtime-adapter",
      agentId: expert.id,
    });
    const createServer = async (instanceId: string) =>
      await createExpertToolsMcpServer({
        agent: expert,
        instanceId,
        getContext: () => undefined,
        logger,
        state: {},
      });

    const first = await createServer("system-session-1");
    const firstId = first.id;
    await first.dispose();

    const restored = await createServer("system-session-1");
    const other = await createServer("system-session-2");
    try {
      expect(restored.id).toBe(firstId);
      expect(other.id).not.toBe(firstId);
    } finally {
      await Promise.all([restored.dispose(), other.dispose()]);
    }
  });
});
