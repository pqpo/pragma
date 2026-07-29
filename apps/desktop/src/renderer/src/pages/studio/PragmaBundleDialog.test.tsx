import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  PragmaBundleImportInspection,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import {
  BundleInspection,
  filterBundleExportRoots,
  orderBundleExportRoots,
} from "./PragmaBundleDialog.tsx";

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

  it("keeps the full result set available to the scrollable list", () => {
    const initial = filterBundleExportRoots(roots, "", kindLabel);
    expect(initial).toHaveLength(50);

    const exact = filterBundleExportRoots(roots, "Resource 49", kindLabel);
    expect(exact).toHaveLength(1);
    expect(exact[0]?.metadata.name).toBe("Resource 49");
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
    expect(teams).toHaveLength(17);

    expect(filterBundleExportRoots(roots, "portable workflow resource 31")).toHaveLength(1);
    expect(filterBundleExportRoots(roots, "release-42")).toHaveLength(1);
    expect(filterBundleExportRoots(roots, "expert:0000000000000009")).toHaveLength(1);
  });
});

describe("Bundle import inspection", () => {
  it("renders every dependency and conflict instead of showing only the conflict count", () => {
    const inspection: PragmaBundleImportInspection = {
      sourcePath: "/tmp/portable-workflow.pragma",
      bundleFingerprint: "a".repeat(64),
      root: {
        ref: "expert:1xddvess309a6gme",
        kind: "Expert",
        name: "菜鸟 APP 查件业务专家",
      },
      createdAt: "2026-07-29T08:00:00.000Z",
      archiveBytes: 1_024,
      unpackedBytes: 2_048,
      fileCount: 4,
      resources: 3,
      dependencies: [
        {
          kind: "runtime",
          ref: "runtime-profile:codex",
          name: "Codex / GPT-5.6-Sol",
          included: false,
        },
        {
          kind: "capability",
          ref: "capability:aone-km",
          name: "aone-km",
          included: true,
        },
      ],
      conflicts: [
        {
          ref: "expert:1xddvess309a6gme",
          kind: "identity",
          localName: "本地查件专家",
          importedName: "菜鸟 APP 查件业务专家",
        },
        {
          ref: "runtime-profile:codex",
          kind: "identity",
          localName: "本地 Codex",
          importedName: "Codex / GPT-5.6-Sol",
        },
        {
          ref: "capability:aone-km",
          kind: "name",
          localName: "本地 aone-km",
          importedName: "aone-km",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <BundleInspection
        inspection={inspection}
        conflictMode="update"
        onConflictMode={() => undefined}
        onChooseAnother={() => undefined}
      />,
    );

    expect(html.match(/class="pragma-bundle-conflict-item"/g)).toHaveLength(3);
    expect(html).toContain("菜鸟 APP 查件业务专家");
    expect(html).toContain("Codex / GPT-5.6-Sol");
    expect(html).toContain("capability:aone-km");
    expect(html).toContain("needs-binding");
    expect(html).toContain("is-included");
  });
});
