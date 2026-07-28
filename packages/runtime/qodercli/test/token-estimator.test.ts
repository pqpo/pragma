import { describe, expect, it } from "vitest";

import { defaultTokenEstimator } from "../src/token-estimator.ts";

describe("Qoder context token estimator", () => {
  it("uses deterministic ASCII and non-ASCII weights", () => {
    expect(defaultTokenEstimator.count("")).toBe(0);
    expect(defaultTokenEstimator.count("abcdefgh")).toBe(2);
    expect(defaultTokenEstimator.count("上下文")).toBe(3);
    expect(defaultTokenEstimator.count("test上下文")).toBe(4);
  });
});
