import { describe, expect, it } from "vitest";
import { describeRuntimeConformance } from "@pragma/core/testing/vitest";
import { createCodexRuntime } from "../src/index.ts";

describeRuntimeConformance("Codex", { createRuntime: createCodexRuntime });

describe("Codex Runtime contract", () => {
  it("declares split Session lifecycle capabilities with native steer", () => {
    const runtime = createCodexRuntime();
    expect(runtime.descriptor.capabilities).toMatchObject({
      supportsResume: true,
      supportsCancel: true,
      supportsClose: true,
      supportsSteer: true,
      supportsContextWindowInspection: true,
      supportsManualCompaction: true,
      supportsContextCompactionEvents: true,
    });
  });
});
