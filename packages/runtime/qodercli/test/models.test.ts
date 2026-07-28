import { describe, expect, it } from "vitest";

import { mapQoderModel, resolveQoderContextWindow } from "../src/models.ts";

describe("Qoder model mapping", () => {
  it("maps model defaults, thinking efforts, and provider identity", () => {
    expect(
      mapQoderModel({
        value: "performance",
        displayName: "Performance",
        description: "Fast",
        isDefault: true,
        supportsDisabled: true,
        efforts: ["low", "high"],
        defaultEffort: "high",
      }),
    ).toMatchObject({
      id: "performance",
      default: true,
      provider: { id: "qoder", kind: "runtime-managed" },
      thinking: {
        defaultLevel: "high",
        supportedLevels: [
          { value: "none" },
          { value: "low" },
          { value: "high" },
        ],
      },
    });
  });

  it("uses the model default context window and allows an explicit override", () => {
    const model = {
      value: "performance",
      displayName: "Performance",
      description: "Fast",
      availableContextWindows: [100_000, 200_000],
      defaultContextWindow: 200_000,
    };
    expect(resolveQoderContextWindow(model, undefined)).toBe(200_000);
    expect(resolveQoderContextWindow(model, 300_000)).toBe(300_000);
  });

  it("fails closed when no context denominator is available", () => {
    expect(() =>
      resolveQoderContextWindow(
        { value: "unknown", displayName: "Unknown", description: "" },
        undefined,
      ),
    ).toThrow("does not report a context window");
  });
});
