import { describe, expect, it } from "vitest";

import type { HomeProject } from "../../../../shared/contracts/home-projects.ts";
import { orderHomeProjects, previewHomeItemDragOrder } from "./home-ordering.ts";

const projects: readonly HomeProject[] = ["a", "b", "c"].map((id, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  name: `Project ${id}`,
  executorRef: "expert:0000000000pragma",
  contextStoreIds: [],
  workspace: { path: `/tmp/${id}`, basename: id },
}));

describe("home item ordering", () => {
  it("orders projects by a complete list of project IDs", () => {
    expect(
      orderHomeProjects(projects, [projects[2]!.id, projects[0]!.id, projects[1]!.id]),
    ).toEqual([projects[2], projects[0], projects[1]]);
  });

  it.each([
    { order: [projects[0]!.id, projects[1]!.id] },
    { order: [projects[0]!.id, projects[0]!.id, projects[2]!.id] },
    {
      order: [projects[0]!.id, projects[1]!.id, "00000000-0000-4000-8000-000000000099"],
    },
  ])(
    "keeps the current order when a drag preview is not a full project permutation",
    ({ order }) => {
      expect(orderHomeProjects(projects, order)).toBe(projects);
    },
  );

  it("moves the dragged item before or after a target", () => {
    expect(previewHomeItemDragOrder(["a", "b", "c", "d"], "a", "c", false)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
    expect(previewHomeItemDragOrder(["a", "b", "c", "d"], "a", "c", true)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });
});
