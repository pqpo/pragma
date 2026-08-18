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
  PragmaBundleDialog,
  visibleBundleExportRoots,
} from "./PragmaBundleDialog.tsx";

type ExportRoot = Extract<
  PragmaProjectSnapshot["resources"][number],
  { kind: "Expert" | "ExpertTeam" | "Flow" }
>;

function exportRoot(index: number): ExportRoot {
  const kind = (["Expert", "ExpertTeam", "Flow"] as const)[index % 3] ?? "Expert";
  const id = index.toString(32).padStart(16, "0");
  return {
    apiVersion: "pragma/v4",
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

  it("shows export objects in pages of twenty and keeps the rest available", () => {
    const initial = filterBundleExportRoots(roots, "", kindLabel);
    expect(initial).toHaveLength(50);
    expect(visibleBundleExportRoots(initial, 1)).toHaveLength(20);
    expect(visibleBundleExportRoots(initial, 2)).toHaveLength(40);
    expect(visibleBundleExportRoots(initial, 3)).toHaveLength(50);

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

  it("returns an explicit empty result for unmatched searches", () => {
    expect(filterBundleExportRoots(roots, "definitely-not-a-resource", kindLabel)).toEqual([]);
  });

  it("requires an explicit export root selection", () => {
    const project: PragmaProjectSnapshot = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "studio",
      revision: 1,
      resources: [exportRoot(0)],
      diagnostics: [],
    };
    const html = renderToStaticMarkup(
      <PragmaBundleDialog
        mode="export"
        project={project}
        capabilities={[]}
        contextStores={[]}
        runtimes={[]}
        onRefreshRuntimes={async () => []}
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain("Select export object");
    expect(html).toContain('class="primary-button" type="button" disabled=""');
    expect(html).toContain("<strong>Resource 0</strong>");
    expect(html).toContain("Configure bundle contents");
  });
});

describe("Bundle import inspection", () => {
  it("renders every dependency and conflict instead of showing only the conflict count", () => {
    const inspection: PragmaBundleImportInspection = {
      sourcePath: "/tmp/portable-workflow.pragma",
      sourceName: "portable-workflow.pragma",
      bundleFingerprint: "a".repeat(64),
      projectFingerprint: "b".repeat(64),
      projectRevision: 3,
      root: {
        ref: "expert:1xddvess309a6gme",
        kind: "Expert",
        name: "菜鸟 APP 查件业务专家",
      },
      roots: [
        {
          ref: "expert:1xddvess309a6gme",
          kind: "Expert",
          name: "菜鸟 APP 查件业务专家",
        },
      ],
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
          resourceKind: "Expert",
          importedName: "菜鸟 APP 查件业务专家",
          matches: [
            {
              kind: "identity",
              localRef: "expert:2xddvess309a6gme",
              localName: "本地查件专家",
            },
          ],
          updateAllowed: true,
        },
        {
          ref: "runtime-profile:codex",
          resourceKind: "RuntimeProfile",
          importedName: "Codex / GPT-5.6-Sol",
          matches: [
            {
              kind: "identity",
              localRef: "runtime-profile:codex",
              localName: "本地 Codex",
            },
          ],
          updateAllowed: true,
        },
        {
          ref: "capability:aone-km",
          resourceKind: "Capability",
          importedName: "aone-km",
          matches: [
            {
              kind: "name",
              localRef: "capability:local-aone-km",
              localName: "本地 aone-km",
            },
          ],
          updateAllowed: true,
        },
      ],
      requirements: [],
      readiness: [],
      sameContentInstallationIds: [],
    };

    const html = renderToStaticMarkup(
      <BundleInspection
        inspection={inspection}
        selections={{
          "expert:1xddvess309a6gme": "update",
          "runtime-profile:codex": "update",
          "capability:aone-km": "update",
        }}
        onChange={() => undefined}
      />,
    );

    expect(html.match(/<article/g)).toHaveLength(3);
    expect(html).toContain("菜鸟 APP 查件业务专家");
    expect(html).toContain("Codex / GPT-5.6-Sol");
    expect(html).toContain("capability:aone-km");
    expect(html).toContain("本地查件专家");
  });
});
