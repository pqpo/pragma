import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createMcpToolRegistry } from "../src/mcp-tools.ts";
import { createSdkMcpServer } from "../src/sdk-mcp-server.ts";

describe("createSdkMcpServer", () => {
  it("wraps local functions as in-process MCP tools", async () => {
    const sdkServer = createSdkMcpServer({
      id: "local_math",
      name: "Local Math",
      tools: [
        {
          name: "add",
          description: "Add two numbers.",
          inputSchema: z.object({
            left: z.number(),
            right: z.number(),
          }),
          call(input) {
            const values = input as { left: number; right: number };
            return {
              sum: values.left + values.right,
            };
          },
        },
      ],
    });
    const registry = await createMcpToolRegistry(sdkServer.mcpConfig);

    try {
      expect(registry.tools.map((tool) => tool.name)).toEqual(["add"]);

      const result = await registry.tools[0]?.call({ left: 2, right: 3 }, undefined);

      expect(result).toMatchObject({
        structuredContent: {
          sum: 5,
        },
      });
    } finally {
      await registry.dispose();
      await sdkServer.dispose();
    }
  });
});
