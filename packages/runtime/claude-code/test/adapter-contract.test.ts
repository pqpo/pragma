import { describe, expect, it } from "vitest";
import { describeRuntimeConformance } from "@pragma/core/testing/vitest";
import { createClaudeCodeRuntime } from "../src/index.ts";

describeRuntimeConformance("Claude Code", { createRuntime: createClaudeCodeRuntime });

describe("Claude Code Runtime contract", () => {
  it("declares split Session lifecycle capabilities without unsafe steer", () => {
    const runtime = createClaudeCodeRuntime();
    expect(runtime.descriptor.capabilities).toMatchObject({
      supportsResume: true,
      supportsCancel: true,
      supportsClose: true,
      supportsSteer: false,
      supportsContextWindowInspection: true,
      supportsManualCompaction: true,
      supportsContextCompactionEvents: true,
    });
  });
});
