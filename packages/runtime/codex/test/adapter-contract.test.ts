import { describe, expect, it } from "vitest";
import { createCodexRuntime } from "../src/index.ts";

describe("Codex Runtime contract", () => {
  it("declares split Session lifecycle capabilities without unsafe steer", () => {
    const runtime = createCodexRuntime();
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
