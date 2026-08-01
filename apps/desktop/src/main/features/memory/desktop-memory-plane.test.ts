import { EXECUTION_CURRENT_EXPERT_ID_ATTR } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { resolveDesktopMemoryRecallScope } from "./desktop-memory-plane.ts";

describe("Desktop Memory recall scope", () => {
  it("intersects the root asset and current Expert policies", async () => {
    const resolveAt = vi.fn(async () => ({
      capture: true,
      recall: true,
      learning: "local-candidates" as const,
      appliedRevisions: [],
    }));
    const now = new Date("2026-08-01T00:00:00.000Z");

    await expect(
      resolveDesktopMemoryRecallScope(
        { resolveAt },
        {
          source: { type: "pragma.expert-team", id: "team-a" },
          attributes: { [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a" },
        },
        now,
      ),
    ).resolves.toEqual({
      rootRef: { type: "pragma.expert-team", id: "team-a" },
      expertRef: { type: "pragma.expert", id: "expert-a" },
    });
    expect(resolveAt).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert-team", id: "team-a" },
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
      occurredAt: now.toISOString(),
    });
  });

  it("fails closed for missing identity or disabled recall", async () => {
    const resolveAt = vi.fn(async () => ({
      capture: true,
      recall: false,
      learning: "local-candidates" as const,
      appliedRevisions: [],
    }));
    await expect(
      resolveDesktopMemoryRecallScope({ resolveAt }, undefined),
    ).resolves.toBeUndefined();
    expect(resolveAt).not.toHaveBeenCalled();
    await expect(
      resolveDesktopMemoryRecallScope(
        { resolveAt },
        {
          source: { type: "pragma.flow", id: "flow-a" },
          attributes: { [EXECUTION_CURRENT_EXPERT_ID_ATTR]: "expert-a" },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
