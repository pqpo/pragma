import { describe, expect, it } from "vitest";

import type { MissionContextStoreEntry } from "../../../shared/contracts/index.ts";
import { buildTreeRows, normalizeInternalContextId } from "./ContextStoreBrowser.tsx";

const metadata = { trigger: "manual", priority: "normal" } as const;

describe("ContextStoreBrowser tree", () => {
  it("pins root documents and creates virtual module folders", () => {
    const entries: MissionContextStoreEntry[] = [
      { id: "semantic/index.md", metadata },
      { id: "overview.md", metadata },
      { id: "guide.md", metadata: { trigger: "always_on", priority: "critical" } },
      { id: "semantic/items/fact-a.md", metadata },
    ];

    expect(
      buildTreeRows(entries).map((row) =>
        row.kind === "directory" ? `folder:${row.id}` : `file:${row.entry.id}`,
      ),
    ).toEqual([
      "file:guide.md",
      "file:overview.md",
      "folder:semantic",
      "file:semantic/index.md",
      "folder:semantic/items",
      "file:semantic/items/fact-a.md",
    ]);
  });

  it("accepts only store-relative internal context ids", () => {
    expect(normalizeInternalContextId("semantic/items/fact-a.md")).toBe("semantic/items/fact-a.md");
    expect(normalizeInternalContextId("../secret.md")).toBeUndefined();
    expect(normalizeInternalContextId("https://example.com")).toBeUndefined();
    expect(normalizeInternalContextId("/absolute.md")).toBeUndefined();
  });
});
