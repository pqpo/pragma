import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  DesktopSquareCatalog,
  DesktopSquareItemDetail,
  PragmaBundleImportInspection,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";
import {
  inspectSquareVersion,
  SquareDirectoryFragment,
  SquareItemVisual,
  squareItemsForView,
} from "./SquareDirectoryFragment.tsx";

describe("SquareDirectoryFragment", () => {
  it("defaults to all resource kinds and exposes source and business-category filters", () => {
    const html = renderToStaticMarkup(<SquareDirectoryFragment onInstall={() => undefined} />);

    expect(html).toContain('role="tablist"');
    expect(html).toContain("All types");
    expect(html).toContain("Experts");
    expect(html).toContain("Expert teams");
    expect(html).toContain("Flows");
    expect(html).toContain("Knowledge bases");
    expect(html).toContain("All business categories");
    expect(html).toContain("All sources");
    expect(html).toContain("Latest");
    expect(html).toContain("Name");
    expect(html).not.toContain("Hottest");
  });

  it("combines type, source, business-category, search, and sort filters", () => {
    const items = [
      squareItem("expert", "Reviewer", SOURCE_A, "software-development", "2026-09-14"),
      squareItem("expert-team", "Release team", SOURCE_A, "productivity", "2026-09-15"),
      squareItem("flow", "Release flow", SOURCE_B, "software-development", "2026-09-16"),
      squareItem("knowledge-base", "Release handbook", SOURCE_B, "research", "2026-09-17"),
    ];

    expect(
      squareItemsForView(items, {
        kind: "all",
        sourceId: "all",
        category: "all",
        query: "",
        sort: "latest",
        locale: "en",
      }).map((item) => item.kind),
    ).toEqual(["knowledge-base", "flow", "expert-team", "expert"]);
    expect(
      squareItemsForView(items, {
        kind: "all",
        sourceId: SOURCE_B,
        category: "software-development",
        query: "release",
        sort: "name",
        locale: "en",
      }).map((item) => item.name.default),
    ).toEqual(["Release flow"]);
    expect(
      squareItemsForView(items, {
        kind: "expert-team",
        sourceId: SOURCE_A,
        category: "all",
        query: "release",
        sort: "latest",
        locale: "en",
      }).map((item) => item.name.default),
    ).toEqual(["Release team"]);
  });

  it("renders the configured expert avatar in both card and detail sizes", () => {
    const item = squareItem("expert", "Reviewer", SOURCE_A, "general", "2026-09-17");

    expect(renderToStaticMarkup(<SquareItemVisual item={item} size="md" />)).toContain("expert-07");
    expect(renderToStaticMarkup(<SquareItemVisual item={item} size="lg" />)).toContain("expert-07");
  });

  it("downloads and inspects the selected version with the downloaded root", async () => {
    const item = squareItem("flow", "Release flow", SOURCE_B, "general", "2026-09-17");
    const detail: DesktopSquareItemDetail = {
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      sourceOfficial: item.sourceOfficial,
      commit: item.commit,
      item,
    };
    const inspection: PragmaBundleImportInspection = {
      sourcePath: "/tmp/release-flow.pragma",
      sourceName: "release-flow.pragma",
      bundleFingerprint: "b".repeat(64),
      projectFingerprint: "c".repeat(64),
      projectRevision: 3,
      root: { ref: item.rootRef, kind: "Flow", name: "Release flow" },
      roots: [{ ref: item.rootRef, kind: "Flow", name: "Release flow" }],
      createdAt: "2026-09-17T00:00:00.000Z",
      archiveBytes: 1_024,
      unpackedBytes: 2_048,
      fileCount: 4,
      resources: 3,
      dependencies: [],
      conflicts: [],
      requirements: [],
      readiness: [],
      sameContentInstallationIds: [],
    };
    const downloadSquareBundle = vi.fn(async () => ({
      path: "/tmp/release-flow.pragma",
      rootRef: item.rootRef,
      sha256: "a".repeat(64),
      cached: true,
    }));
    const inspectPragmaBundle = vi.fn(async () => inspection);
    const api = { downloadSquareBundle, inspectPragmaBundle } satisfies Pick<
      PragmaDesktopAPI,
      "downloadSquareBundle" | "inspectPragmaBundle"
    >;

    await expect(inspectSquareVersion(api, detail, "1.0.0")).resolves.toEqual({
      version: "1.0.0",
      path: "/tmp/release-flow.pragma",
      inspection,
    });
    expect(downloadSquareBundle).toHaveBeenCalledWith({
      sourceId: SOURCE_B,
      kind: "flow",
      itemId: "release-flow",
      version: "1.0.0",
    });
    expect(inspectPragmaBundle).toHaveBeenCalledWith({
      sourcePath: "/tmp/release-flow.pragma",
      rootRef: item.rootRef,
    });
  });
});

const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";

function squareItem(
  kind: DesktopSquareCatalog["items"][number]["kind"],
  name: string,
  sourceId: string,
  categoryId: string,
  updatedDate: string,
): DesktopSquareCatalog["items"][number] {
  const id = name.toLowerCase().replaceAll(" ", "-");
  const rootPrefix =
    kind === "expert-team" ? "team" : kind === "knowledge-base" ? "context-store" : kind;
  return {
    schemaVersion: "pragma.bundle-source-item/v2",
    id,
    rootRef: `${rootPrefix}:1234567890abcdef`,
    name: { default: name },
    summary: { default: `${name} summary` },
    description: { default: `${name} description` },
    author: { name: "Pragma" },
    license: "MIT",
    tags: ["release"],
    ...(kind === "expert" || kind === "expert-team" ? { avatarId: "pragma.avatar.expert.07" } : {}),
    latestVersion: "1.0.0",
    createdAt: `${updatedDate}T00:00:00.000Z`,
    updatedAt: `${updatedDate}T00:00:00.000Z`,
    kind,
    categoryId,
    versions: ["1.0.0"],
    configPath: `${kind}/${categoryId}/${id}/config.yaml`,
    sourceId,
    sourceName: sourceId === SOURCE_A ? "Source A" : "Source B",
    sourceOfficial: sourceId === SOURCE_A,
    commit: "a".repeat(40),
  };
}
