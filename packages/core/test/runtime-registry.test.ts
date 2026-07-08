import type { RuntimeAdapter } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { createRuntimeRegistry } from "../src/runtime-registry.ts";

describe("runtime registry", () => {
  it("allows an empty registry and reports missing runtimes on resolve", () => {
    const registry = createRuntimeRegistry();

    expect(registry.defaultRuntime).toBe("default");
    expect(registry.list()).toEqual([]);
    expect(() => registry.resolve()).toThrow("Runtime is not registered: default");
  });

  it("resolves explicit runtimes and rejects duplicates", () => {
    const runtime = createFakeRuntime("custom");

    expect(
      createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: "custom",
      }).resolve("custom"),
    ).toBe(runtime);

    expect(() =>
      createRuntimeRegistry({
        runtimes: [runtime, runtime],
        defaultRuntime: "custom",
      }),
    ).toThrow("Duplicate runtime id: custom");
  });
});

function createFakeRuntime(id: string): RuntimeAdapter {
  return {
    descriptor: {
      id,
      kind: "fake-runtime",
      displayName: "Fake Runtime",
    },
    async createSession() {
      throw new Error("Not implemented in registry tests.");
    },
  };
}
