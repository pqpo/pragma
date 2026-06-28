import type { RuntimeAdapter } from "@expertmesh/core";
import { describe, expect, it } from "vitest";

import { createDefaultRuntime, createRuntimeRegistry } from "../src/runtime-registry.ts";

describe("runtime registry", () => {
  it("creates a default runtime facade backed by the cloud PI adapter", () => {
    const runtime = createDefaultRuntime();

    expect(runtime.descriptor).toMatchObject({
      id: "default",
      kind: "cloud-pi-agent",
      displayName: "Default Runtime",
      capabilities: {
        targets: ["agent"],
      },
    });
  });

  it("injects the default runtime when no runtimes are supplied", () => {
    const registry = createRuntimeRegistry();

    expect(registry.defaultRuntime).toBe("default");
    expect(registry.resolve().descriptor.id).toBe("default");
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
