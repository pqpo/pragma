import { describe, expect, it } from "vitest";

import { BUILT_IN_STEWARD_REF } from "@pragma/steward";

import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";

describe("DesktopSystemExpertRegistry", () => {
  it("exposes the Steward as a read-only, system-default Expert and mission executor", () => {
    const registry = createDesktopSystemExpertRegistry();
    const definition = registry.get(BUILT_IN_STEWARD_REF);

    expect(definition).toMatchObject({
      ref: BUILT_IN_STEWARD_REF,
      id: "steward",
      origin: "built-in",
      readOnly: true,
      executionProfile: { mode: "system-default" },
    });
    expect(registry.list()).toContainEqual(
      expect.objectContaining({ ref: BUILT_IN_STEWARD_REF, readOnly: true }),
    );
    expect(registry.listExecutors()).toContainEqual(
      expect.objectContaining({
        ref: BUILT_IN_STEWARD_REF,
        kind: "expert",
        origin: "built-in",
        readOnly: true,
      }),
    );
    expect(registry.isReservedRef(BUILT_IN_STEWARD_REF)).toBe(true);
    expect(registry.isReservedId("steward")).toBe(true);
    expect(registry.fingerprint(BUILT_IN_STEWARD_REF)).toMatch(/^[a-f0-9]{64}$/);
  });
});
