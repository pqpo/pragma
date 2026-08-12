import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExpertPromptAttachment } from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseMissionAttachmentPreviewUrl,
  resolveMissionAttachmentImage,
} from "./mission-attachment-preview.ts";

const roots: string[] = [];
const missionId = "00000000-0000-4000-8000-000000000001";
const attachmentId = "00000000-0000-4000-8000-000000000002";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Mission attachment previews", () => {
  it("accepts only canonical preview URLs", () => {
    expect(
      parseMissionAttachmentPreviewUrl(
        `pragma-mission-attachment://preview/${missionId}/${attachmentId}`,
      ),
    ).toEqual({ missionId, attachmentId });
    expect(
      parseMissionAttachmentPreviewUrl(
        `pragma-mission-attachment://original/${missionId}/${attachmentId}`,
      ),
    ).toEqual({ missionId, attachmentId });
    expect(() =>
      parseMissionAttachmentPreviewUrl(
        `pragma-mission-attachment://other/${missionId}/${attachmentId}`,
      ),
    ).toThrow("Invalid Mission attachment preview URL");
    expect(() =>
      parseMissionAttachmentPreviewUrl(
        `pragma-mission-attachment://preview/${missionId}/${attachmentId}/extra`,
      ),
    ).toThrow("Invalid Mission attachment preview URL");
    expect(() =>
      parseMissionAttachmentPreviewUrl(
        `pragma-mission-attachment://preview/${missionId}//${attachmentId}`,
      ),
    ).toThrow("Invalid Mission attachment preview URL");
    expect(() =>
      parseMissionAttachmentPreviewUrl(
        `pragma-mission-attachment://preview/${missionId}/${attachmentId}?download=true`,
      ),
    ).toThrow("Invalid Mission attachment preview URL");
    expect(() =>
      parseMissionAttachmentPreviewUrl(
        `pragma-mission-attachment://preview/not-a-mission/${attachmentId}`,
      ),
    ).toThrow();
  });

  it("serves only image files owned by the Mission attachment directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-preview-"));
    roots.push(root);
    const missionPath = join(root, missionId);
    const imagePath = join(missionPath, "attachments", "images", `${attachmentId}.png`);
    const optimizedPath = join(
      missionPath,
      "attachments",
      "images",
      "optimized",
      `${attachmentId}.webp`,
    );
    await mkdir(join(missionPath, "attachments", "images", "optimized"), { recursive: true });
    await writeFile(imagePath, "image-bytes");
    await writeFile(optimizedPath, "optimized-bytes");
    const attachments: ExpertPromptAttachment[] = [
      {
        id: attachmentId,
        kind: "image",
        name: "screen.png",
        path: imagePath,
        mimeType: "image/png",
        optimized: { path: optimizedPath, mimeType: "image/webp", size: 15 },
      },
    ];
    const store = {
      storagePath: () => missionPath,
      getAttachments: async () => attachments,
    };

    await expect(resolveMissionAttachmentImage(store, missionId, attachmentId)).resolves.toEqual({
      path: await realpath(optimizedPath),
      mimeType: "image/webp",
    });
    await expect(
      resolveMissionAttachmentImage(store, missionId, attachmentId, "original"),
    ).resolves.toEqual({ path: await realpath(imagePath), mimeType: "image/png" });

    const outsidePath = join(root, "outside.png");
    await writeFile(outsidePath, "outside");
    attachments[0] = { ...attachments[0]!, path: outsidePath };
    await expect(
      resolveMissionAttachmentImage(store, missionId, attachmentId, "original"),
    ).rejects.toThrow("escaped its owner directory");
  });

  it("rejects non-image attachments and unknown identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mission-preview-"));
    roots.push(root);
    const missionPath = join(root, missionId);
    await mkdir(join(missionPath, "attachments", "images"), { recursive: true });
    const store = {
      storagePath: () => missionPath,
      getAttachments: async () => [
        {
          id: attachmentId,
          kind: "file" as const,
          name: "notes.txt",
          path: join(root, "notes.txt"),
        },
      ],
    };

    await expect(resolveMissionAttachmentImage(store, missionId, attachmentId)).rejects.toThrow(
      "not found",
    );
    await expect(
      resolveMissionAttachmentImage(store, missionId, "00000000-0000-4000-8000-000000000003"),
    ).rejects.toThrow("not found");
  });
});
