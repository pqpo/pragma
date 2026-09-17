import { describe, expect, it } from "vitest";

import {
  initialPublicationSourceSelection,
  nextPatchVersion,
  publicationVersionsForSelection,
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
});
