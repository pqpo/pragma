import { describe, expect, it } from "vitest";

import { bundleSourcePublicationSummary } from "../../../../shared/contracts/index.ts";

import {
  initialPublicationSourceSelection,
  nextPatchVersion,
  normalizePublicationTag,
  pendingPublicationTags,
  publicationItemIdForSelection,
  publicationVersionsForSelection,
  validatePublicationFields,
} from "./BundleSourcePublishDialog.tsx";

describe("Bundle Source publication selection", () => {
  it("auto-selects exactly one eligible source but leaves multiple sources for the user", () => {
    expect([
      ...initialPublicationSourceSelection([{ selectable: true, source: { id: "one" } }]),
    ]).toEqual(["one"]);
    expect([
      ...initialPublicationSourceSelection([
        { selectable: true, source: { id: "one" } },
        { selectable: false, source: { id: "disabled" } },
        { selectable: true, source: { id: "two" } },
      ]),
    ]).toEqual([]);
  });

  it("suggests the next patch version", () => {
    expect(nextPatchVersion([])).toBe("1.0.0");
    expect(nextPatchVersion(["1.4.2", "2.0.0", "1.9.9"])).toBe("2.0.1");
  });

  it("derives the suggestion from selected sources only", () => {
    const sources = [
      { source: { id: "one" }, existingItem: { versions: ["1.4.2"] } },
      { source: { id: "two" }, existingItem: { versions: ["9.0.0"] } },
      { source: { id: "new" } },
    ];

    expect(nextPatchVersion(publicationVersionsForSelection(sources, new Set(["one"])))).toBe(
      "1.4.3",
    );
    expect(nextPatchVersion(publicationVersionsForSelection(sources, new Set(["new"])))).toBe(
      "1.0.0",
    );
  });

  it("normalizes optional tags and reports invalid or duplicate values", () => {
    expect(normalizePublicationTag(" Release_Candidate ")).toBe("release-candidate");
    expect(pendingPublicationTags([], "通用研发")).toMatchObject({
      tags: [],
      error: { code: "invalidTag" },
    });
    expect(pendingPublicationTags(["release"], "RELEASE")).toMatchObject({
      tags: ["release"],
      error: { code: "duplicateTag" },
    });
    expect(pendingPublicationTags([], "")).toEqual({ tags: [] });
  });

  it("derives a bounded summary from the first description paragraph", () => {
    expect(bundleSourcePublicationSummary(" First line\ncontinues here. \n\nIgnored detail.")).toBe(
      "First line continues here.",
    );
    const bounded = bundleSourcePublicationSummary("😀".repeat(300));
    expect(bounded.length).toBeLessThanOrEqual(500);
    expect(bounded.endsWith("\ud83d")).toBe(false);
  });

  it("validates every editable publication field on submit", () => {
    const metadata = {
      itemId: "reviewer",
      name: "Reviewer",
      summary: "Reviews changes",
      description: "Reviews changes.",
      authorName: "Pragma",
      license: "MIT",
      tags: [],
    };
    expect(validatePublicationFields("1.2.3-beta.1+build.4", metadata)).toEqual({});
    expect(validatePublicationFields("v1.2", metadata)).toMatchObject({
      version: { code: "invalidVersion" },
    });
    expect(
      validatePublicationFields("1.2.3", {
        ...metadata,
        name: " ",
        description: "x".repeat(8_001),
        authorName: "a".repeat(201),
        license: "l".repeat(101),
      }),
    ).toMatchObject({
      name: { code: "required" },
      description: { code: "tooLong", limit: 8_000 },
      authorName: { code: "tooLong", limit: 200 },
      license: { code: "tooLong", limit: 100 },
    });
    expect(
      validatePublicationFields("1".repeat(101), {
        ...metadata,
        name: "n".repeat(201),
        tags: Array.from({ length: 31 }, (_, index) => `tag-${index}`),
      }),
    ).toMatchObject({
      version: { code: "tooLong", limit: 100 },
      name: { code: "tooLong", limit: 200 },
      tags: { code: "tooManyTags", limit: 30 },
    });
    expect(pendingPublicationTags([], "t".repeat(81))).toMatchObject({
      error: { code: "tooLong", field: "tag", limit: 80 },
    });
  });

  it("keeps an existing item id and detects incompatible selected sources", () => {
    const sources = [
      { source: { id: "one" }, existingItem: { id: "reviewer" } },
      { source: { id: "two" }, existingItem: { id: "code-reviewer" } },
      { source: { id: "new" } },
    ];
    expect(publicationItemIdForSelection(sources, new Set(["one", "new"]), "generated")).toEqual({
      itemId: "reviewer",
      conflict: false,
    });
    expect(publicationItemIdForSelection(sources, new Set(["one", "two"]), "generated")).toEqual({
      itemId: "reviewer",
      conflict: true,
    });
  });
});
