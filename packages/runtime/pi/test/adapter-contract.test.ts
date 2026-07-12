import { describe, expect, it } from "vitest";
import { createPiRuntime } from "../src/index.ts";

describe("PI Runtime contract", () => {
  it("declares split Session lifecycle capabilities without unsafe steer", () => {
    const runtime = createPiRuntime();
    expect(runtime.descriptor.capabilities).toMatchObject({
      supportsResume: true,
      supportsCancel: true,
      supportsClose: true,
      supportsSteer: false,
    });
  });
});
