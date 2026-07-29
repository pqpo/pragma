import { describe, expect, it } from "vitest";

import { AgentMessageSchema } from "../src/agent-message.schema.ts";

describe("AgentMessage usage wire compatibility", () => {
  it("marks historical assistant usage without a measurement as unknown", () => {
    expect(
      AgentMessageSchema.parse({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1,
      }),
    ).toMatchObject({
      usage: { measurement: "unknown", totalTokens: 3 },
    });
  });
});
