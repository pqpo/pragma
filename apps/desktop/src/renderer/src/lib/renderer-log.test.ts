import { describe, expect, it } from "vitest";

import { serializeRendererError } from "./renderer-log.ts";

describe("serializeRendererError", () => {
  it("bounds an error and supplemental component stack for the preload protocol", () => {
    const error = new Error("m".repeat(10_000));
    error.stack = "s".repeat(40_000);

    const serialized = serializeRendererError(error, "c".repeat(40_000));

    expect(serialized.errorMessage.length).toBeLessThanOrEqual(8_192);
    expect(serialized.stack?.length).toBeLessThanOrEqual(32_768);
    expect(serialized.errorMessage).toContain("[TRUNCATED]");
    expect(serialized.stack).toContain("[TRUNCATED]");
  });

  it("does not throw when an error property getter is hostile", () => {
    const error = new Error("safe");
    Object.defineProperty(error, "message", {
      get: () => {
        throw new Error("getter failed");
      },
    });

    expect(() => serializeRendererError(error)).not.toThrow();
    expect(serializeRendererError(error).errorMessage).toBe("An error occurred.");
  });
});
