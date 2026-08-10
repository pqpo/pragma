import { describe, expect, it, vi } from "vitest";

import { mergeMissionAttachments, stageClipboardImage } from "./mission-attachments.ts";

describe("Mission composer attachments", () => {
  const existing = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "file" as const,
    name: "notes.md",
    path: "/workspace/notes.md",
  };

  it("deduplicates selected paths and enforces the composer limit", () => {
    expect(mergeMissionAttachments([existing], [{ ...existing, id: crypto.randomUUID() }])).toEqual(
      [existing],
    );
    expect(
      mergeMissionAttachments(
        Array.from({ length: 20 }, (_, index) => ({
          ...existing,
          id: crypto.randomUUID(),
          path: `/workspace/${index}.md`,
        })),
        [{ ...existing, id: crypto.randomUUID(), path: "/workspace/overflow.md" }],
      ),
    ).toBeUndefined();
  });

  it("encodes a pasted image for staging through the preload boundary", async () => {
    const stage = vi.fn(async (input) => ({
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          kind: "image" as const,
          name: input.name,
          path: "/tmp/staged.png",
          mimeType: input.mimeType,
        },
      ],
    }));

    await stageClipboardImage(new File(["image"], "clipboard.png", { type: "image/png" }), stage);

    expect(stage).toHaveBeenCalledWith({
      name: "clipboard.png",
      mimeType: "image/png",
      data: "aW1hZ2U=",
    });
  });
});
