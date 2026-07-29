import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";
import { describe, expect, it } from "vitest";

import { filterBundleExportRoots, orderBundleExportRoots } from "./PragmaBundleDialog.tsx";

type ExportRoot = Extract<
  PragmaProjectSnapshot["resources"][number],
  { kind: "Expert" | "ExpertTeam" | "Flow" }
>;

function exportRoot(index: number): ExportRoot {
  const kind = (["Expert", "ExpertTeam", "Flow"] as const)[index % 3] ?? "Expert";
  const id = index.toString(32).padStart(16, "0");
  return {
    apiVersion: "pragma/v3",
    kind,
    metadata: {
      id,
      name: `Resource ${index}`,
      description: `Portable workflow resource ${index}`,
      tags: [`release-${index}`],
    },
  } as ExportRoot;
}

describe("Bundle export root search", () => {
  const roots = Array.from({ length: 50 }, (_, index) => exportRoot(index));
  const kindLabel = (kind: ExportRoot["kind"]): string =>
    kind === "Expert" ? "专家" : kind === "ExpertTeam" ? "专家团" : "Flow";

  it("limits the default list while searching the full resource catalog", () => {
    const initial = filterBundleExportRoots(roots, "", kindLabel);
    expect(initial.items).toHaveLength(5);
    expect(initial.matchCount).toBe(50);

    const exact = filterBundleExportRoots(roots, "Resource 49", kindLabel);
    expect(exact.matchCount).toBe(1);
    expect(exact.items[0]?.metadata.name).toBe("Resource 49");
  });

  it("orders an unstable project resource list predictably", () => {
    const shuffled = [exportRoot(10), exportRoot(2), exportRoot(1)];

    expect(orderBundleExportRoots(shuffled).map((resource) => resource.metadata.name)).toEqual([
      "Resource 1",
      "Resource 2",
      "Resource 10",
    ]);
  });

  it("searches localized kinds, resource refs, descriptions, and tags", () => {
    const teams = filterBundleExportRoots(roots, "专家团", kindLabel);
    expect(teams.items).toHaveLength(5);
    expect(teams.matchCount).toBe(17);

    expect(filterBundleExportRoots(roots, "portable workflow resource 31").matchCount).toBe(1);
    expect(filterBundleExportRoots(roots, "release-42").matchCount).toBe(1);
    expect(filterBundleExportRoots(roots, "expert:0000000000000009").matchCount).toBe(1);
  });
});
