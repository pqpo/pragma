import { describe, expect, it } from "vitest";

import {
  createMemorySubjectNameIndex,
  loadMemorySubjectNameIndex,
  selectMemorySubjectNames,
} from "./memory-subject-names.ts";

describe("memory subject names", () => {
  it("indexes current project assets and built-in Experts by memory subject reference", () => {
    const names = createMemorySubjectNameIndex({
      project: {
        resources: [
          { kind: "Expert", metadata: { id: "expert-a", name: "研发专家" } },
          { kind: "ExpertTeam", metadata: { id: "team-a", name: "AI研发团队" } },
          { kind: "Flow", metadata: { id: "flow-a", name: "发布流程" } },
          { kind: "Capability", metadata: { id: "capability-a", name: "不应展示" } },
        ],
      },
      systemExperts: [{ id: "system-a", name: "Pragma" }],
    });

    expect(names).toEqual({
      "pragma.expert:expert-a": "研发专家",
      "pragma.expert-team:team-a": "AI研发团队",
      "pragma.flow:flow-a": "发布流程",
      "pragma.expert:system-a": "Pragma",
    });
  });

  it("selects only names used by the memory item and omits unresolved references", () => {
    const selected = selectMemorySubjectNames(
      {
        "pragma.expert-team:team-a": "AI研发团队",
        "pragma.expert:expert-a": "研发专家",
      },
      [
        { type: "pragma.expert-team", id: "team-a" },
        { type: "pragma.expert", id: "missing" },
      ],
    );

    expect(selected).toEqual({ "pragma.expert-team:team-a": "AI研发团队" });
  });

  it("falls back to an empty index when the resource directory is unavailable", async () => {
    await expect(
      loadMemorySubjectNameIndex({
        getProject: async () => {
          throw new Error("project_unavailable");
        },
        listSystemExperts: () => {
          throw new Error("system_experts_unavailable");
        },
      }),
    ).resolves.toEqual({});
  });
});
