import { describe, expect, it } from "vitest";

import { createQoderCliRuntime } from "../src/adapter.ts";

describe("Qoder CLI Runtime adapter", () => {
  it("declares local streaming, MCP, context inspection, and compaction", () => {
    const adapter = createQoderCliRuntime({
      executablePath: "/opt/qodercli",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
    });

    expect(adapter.descriptor).toMatchObject({
      id: "qodercli-local",
      kind: "qodercli-local",
      capabilities: {
        targets: ["agent"],
        executionLocations: ["local"],
        supportsStreaming: true,
        supportsMcp: true,
        supportsContextWindowInspection: true,
        supportsManualCompaction: true,
        supportsResume: true,
        supportsCancel: true,
        supportsClose: true,
        supportsSteer: false,
      },
    });
  });
});
