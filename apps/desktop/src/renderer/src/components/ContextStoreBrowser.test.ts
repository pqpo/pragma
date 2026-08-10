import { describe, expect, it } from "vitest";

import type { MissionContextStoreEntry } from "../../../shared/contracts/index.ts";
import {
  buildTreeRows,
  entryPreviewKind,
  normalizeInternalContextId,
  summaryFromContent,
} from "./ContextStoreBrowser.tsx";

const metadata = { trigger: "manual", priority: "normal" } as const;

describe("ContextStoreBrowser tree", () => {
  it("pins root documents and creates virtual module folders", () => {
    const entries: MissionContextStoreEntry[] = [
      { id: "semantic/index.md", metadata },
      { id: "overview.md", metadata },
      { id: "GUIDE.md", metadata: { trigger: "always_on", priority: "critical" } },
      { id: "semantic/items/fact-a.md", metadata },
    ];

    expect(
      buildTreeRows(entries).map((row) =>
        row.kind === "directory" ? `folder:${row.id}` : `file:${row.entry.id}`,
      ),
    ).toEqual([
      "file:GUIDE.md",
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

  it("uses explicit Mission Board preview kinds while keeping legacy memory entries textual", () => {
    expect(entryPreviewKind({ id: "preview.png", previewKind: "image" })).toBe("image");
    expect(entryPreviewKind({ id: "archive.pdf", previewKind: "unsupported" })).toBe("unsupported");
    expect(entryPreviewKind({ id: "overview.md" })).toBe("text");
  });

  it("preserves preview metadata when a new entry is discovered from search", () => {
    expect(
      summaryFromContent({
        id: "research/reference.png",
        metadata,
        sizeBytes: 42,
        mediaType: "image/png",
        previewKind: "image",
        content: "AA==",
        contentEncoding: "base64",
        contentRange: {
          requestedStartOffset: 0,
          startOffset: 0,
          endOffset: 1,
          nextStartOffset: 1,
          truncated: false,
        },
      }),
    ).toMatchObject({
      id: "research/reference.png",
      sizeBytes: 42,
      mediaType: "image/png",
      previewKind: "image",
    });
  });
});
