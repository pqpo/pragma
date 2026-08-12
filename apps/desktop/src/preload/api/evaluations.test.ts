import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMutation } = vi.hoisted(() => ({ invokeMutation: vi.fn() }));

vi.mock("../invoke-mutation.ts", () => ({ invokeMutation }));

import { evaluationsApi } from "./evaluations.ts";

describe("evaluationsApi", () => {
  beforeEach(() => invokeMutation.mockReset());

  it("reads an empty run list from the unwrapped Desktop mutation value", async () => {
    invokeMutation.mockResolvedValueOnce([]);

    await expect(evaluationsApi.listAgentEvaluationRuns()).resolves.toEqual([]);
    expect(invokeMutation).toHaveBeenCalledWith("evaluations:runs:list");
  });
});
