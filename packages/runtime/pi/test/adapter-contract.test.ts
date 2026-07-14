import { describe, expect, it } from "vitest";
import { createPiRuntime } from "../src/index.ts";

describe("PI Runtime contract", () => {
  it("declares split Session lifecycle capabilities with safe steer", () => {
    const runtime = createPiRuntime();
    expect(runtime.descriptor.capabilities).toMatchObject({
      supportsResume: true,
      supportsCancel: true,
      supportsClose: true,
      supportsSteer: true,
    });
  });
});
