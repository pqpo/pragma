import { describe, expect, it } from "vitest";

import { createAntigravityRuntime } from "../src/index.ts";

describe("Antigravity Runtime contract", () => {
  it("declares local agent, streaming, MCP, model, effort, resume, and lifecycle capabilities", () => {
    const runtime = createAntigravityRuntime({
      listModels: async () => [],
      canUse: () => ({ usable: true }),
    });

    expect(runtime.descriptor).toMatchObject({
      id: "antigravity",
      kind: "antigravity-local",
      displayName: "Antigravity CLI",
      capabilities: {
        targets: ["agent"],
        executionLocations: ["local"],
        supportsAbort: true,
        supportsMcp: true,
        supportsModelDiscovery: true,
        supportsStreaming: true,
        supportsThinkingLevel: true,
        supportsResume: true,
        supportsCancel: true,
        supportsClose: true,
        supportsSteer: false,
        supportsContextCompactionEvents: true,
      },
    });
  });

  it("allows the Desktop Host to bind the immutable Runtime Environment identity", () => {
    const runtime = createAntigravityRuntime({
      descriptor: { id: "antigravity", displayName: "Desktop Antigravity" },
      listModels: async () => [],
      canUse: () => ({ usable: true }),
    });

    expect(runtime.descriptor.id).toBe("antigravity");
    expect(runtime.descriptor.displayName).toBe("Desktop Antigravity");
    expect(runtime.descriptor.kind).toBe("antigravity-local");
  });
});
