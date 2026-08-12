import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { createMissionImageDraftStore } from "./mission-image-drafts.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Mission image drafts", () => {
  it("creates a compact model rendition and keeps the original available", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-image-draft-"));
    roots.push(root);
    const source = join(root, "large.png");
    await sharp({
      create: { width: 2_400, height: 1_800, channels: 4, background: "#4a8f72" },
    })
      .png()
      .toFile(source);
    const sourceSize = (await stat(source)).size;
    const store = createMissionImageDraftStore({ temporaryRoot: root });

    const result = await store.stagePath(source);
    const attachment = result.attachments[0]!;

    expect(result.previews[0]?.dataUrl).toMatch(/^data:image\/webp;base64,/u);
    expect(attachment.path).toBe(source);
    expect(attachment.optimized).toMatchObject({ mimeType: "image/webp" });
    expect(attachment.optimized!.size).toBeLessThanOrEqual(1024 * 1024);
    await expect(store.resolveOriginal(attachment.id)).resolves.toEqual({
      path: source,
      mimeType: "image/png",
    });

    await store.discard([attachment.id]);
    await expect(access(attachment.optimized!.path)).rejects.toThrow();
    expect((await stat(source)).size).toBe(sourceSize);
  });

  it("rejects clipboard bytes whose declared type does not match", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-image-draft-"));
    roots.push(root);
    const store = createMissionImageDraftStore({ temporaryRoot: root });
    const png = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();

    await expect(
      store.stageClipboard({
        name: "wrong.jpg",
        mimeType: "image/jpeg",
        data: png.toString("base64"),
      }),
    ).rejects.toThrow("does not match");
  });

  it("optimizes GIFs smaller than the minimum resize edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-image-draft-"));
    roots.push(root);
    const source = join(root, "small.gif");
    await sharp({
      create: { width: 200, height: 160, channels: 4, background: "#4a8f72" },
    })
      .gif()
      .toFile(source);
    const store = createMissionImageDraftStore({ temporaryRoot: root });

    const result = await store.stagePath(source);

    expect(result.attachments[0]).toMatchObject({
      mimeType: "image/gif",
      optimized: { mimeType: "image/webp" },
    });
    expect(result.attachments[0]?.optimized?.size).toBeLessThanOrEqual(1024 * 1024);
  });
});
