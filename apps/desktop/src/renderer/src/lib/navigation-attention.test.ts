import { describe, expect, it } from "vitest";
import type { MissionSummary } from "../../../shared/contracts/index.ts";
import { missionNeedsAttention } from "./navigation-attention.ts";

const mission: MissionSummary = {
  id: "mission-a",
  title: "Research",
  workspace: { basename: "workspace" },
  executor: { kind: "expert", name: "Researcher" },
  source: { type: "task" },
  lifecycleStatus: "active",
  updatedAt: "2026-10-22T00:00:00.000Z",
};

describe("navigation attention", () => {
  it("includes unread tasks and automations, and clears after reading", () => {
    for (const source of [
      mission.source,
      { type: "automation", automationRef: "automation:daily" },
    ] as const) {
      const item = { ...mission, source };
      expect(missionNeedsAttention(item, [mission.id])).toBe(true);
      expect(missionNeedsAttention(item, [])).toBe(false);
    }
  });

  it("excludes unread completed tasks and automations from navigation attention", () => {
    for (const source of [
      mission.source,
      { type: "automation", automationRef: "automation:daily" },
    ] as const) {
      const completed = { ...mission, source, lifecycleStatus: "completed" } as const;
      expect(missionNeedsAttention(completed, [mission.id])).toBe(false);
      expect(missionNeedsAttention({ ...completed, lifecycleStatus: "active" }, [mission.id])).toBe(
        true,
      );
    }
  });

  it("keeps human input pending after reading and clears when execution resumes", () => {
    expect(
      missionNeedsAttention(
        { ...mission, execution: { status: "waiting", waitReason: "human_input" } },
        [],
      ),
    ).toBe(true);
    expect(missionNeedsAttention({ ...mission, execution: { status: "running" } }, [])).toBe(false);
  });

  it("uses the completed list group rather than the status of a single execution", () => {
    const succeeded = { ...mission, execution: { status: "succeeded" } } as const;
    expect(missionNeedsAttention(succeeded, [mission.id])).toBe(true);
    expect(
      missionNeedsAttention({ ...succeeded, lifecycleStatus: "completed" }, [mission.id]),
    ).toBe(false);
  });

  it("ignores internal work and waiting for experts", () => {
    expect(missionNeedsAttention({ ...mission, source: { type: "internal" } }, [mission.id])).toBe(
      false,
    );
    expect(
      missionNeedsAttention(
        { ...mission, execution: { status: "waiting", waitReason: "experts" } },
        [],
      ),
    ).toBe(false);
    expect(
      missionNeedsAttention(
        { ...mission, lifecycleStatus: "completed", execution: { status: "waiting" } },
        [],
      ),
    ).toBe(false);
  });
});
