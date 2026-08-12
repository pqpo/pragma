import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ExpertPromptAttachment } from "@pragma/shared";
import sharp, { type Metadata } from "sharp";

import type {
  PickMissionAttachmentsResult,
  StageMissionClipboardImage,
} from "../../../shared/contracts/index.ts";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 80_000_000;
const OPTIMIZED_TARGET_BYTES = 1024 * 1024;
const OPTIMIZED_MAX_EDGE = 1_600;
const OPTIMIZED_MIN_EDGE = 512;
const THUMBNAIL_EDGE = 192;

interface DraftImageRecord {
  readonly originalPath: string;
  readonly mimeType: SupportedImageMimeType;
  readonly ownedPaths: ReadonlySet<string>;
}

type SupportedImageMimeType = StageMissionClipboardImage["mimeType"];

export interface MissionImageDraftStore {
  stagePath(path: string): Promise<PickMissionAttachmentsResult>;
  stageClipboard(input: StageMissionClipboardImage): Promise<PickMissionAttachmentsResult>;
  discard(attachmentIds: readonly string[]): Promise<void>;
  resolveOriginal(attachmentId: string): Promise<{
    readonly path: string;
    readonly mimeType: SupportedImageMimeType;
  }>;
}

export function createMissionImageDraftStore(options: {
  readonly temporaryRoot: string;
}): MissionImageDraftStore {
  const stagingRoot = join(options.temporaryRoot, "mission-image-drafts");
  const records = new Map<string, DraftImageRecord>();

  const stage = async (input: {
    readonly name: string;
    readonly originalPath: string;
    readonly ownedOriginal: boolean;
  }): Promise<PickMissionAttachmentsResult> => {
    const attachmentId = randomUUID();
    const { metadata, mimeType } = await inspectImage(input.originalPath);
    const source = await stat(input.originalPath);
    const ownedPaths = new Set<string>(input.ownedOriginal ? [input.originalPath] : []);
    try {
      const optimized = shouldOptimize(source.size, metadata)
        ? await createOptimizedImage({
            attachmentId,
            metadata,
            sourcePath: input.originalPath,
            stagingRoot,
          })
        : undefined;
      if (optimized !== undefined) ownedPaths.add(optimized.path);
      const preview = await createThumbnail(input.originalPath);
      const attachment: ExpertPromptAttachment = {
        id: attachmentId,
        kind: "image",
        name: input.name,
        path: input.originalPath,
        mimeType,
        size: source.size,
        ...(optimized === undefined ? {} : { optimized }),
      };
      records.set(attachmentId, {
        originalPath: input.originalPath,
        mimeType,
        ownedPaths,
      });
      return {
        attachments: [attachment],
        previews: [
          { attachmentId, dataUrl: `data:image/webp;base64,${preview.toString("base64")}` },
        ],
      };
    } catch (error) {
      await discardOwnedPaths(ownedPaths);
      throw error;
    }
  };

  const discard = async (attachmentIds: readonly string[]): Promise<void> => {
    const ownedPaths = new Set<string>();
    for (const attachmentId of attachmentIds) {
      const record = records.get(attachmentId);
      if (record === undefined) continue;
      records.delete(attachmentId);
      for (const path of record.ownedPaths) ownedPaths.add(path);
    }
    await discardOwnedPaths(ownedPaths);
  };

  return {
    async stagePath(path) {
      return await stage({ name: basename(path), originalPath: path, ownedOriginal: false });
    },
    async stageClipboard(input) {
      const data = Buffer.from(input.data, "base64");
      if (data.byteLength === 0 || data.byteLength > MAX_SOURCE_BYTES) {
        throw new Error("Pasted images must be 20 MiB or smaller.");
      }
      const originalPath = join(
        stagingRoot,
        `${randomUUID()}.original${imageExtension(input.mimeType)}`,
      );
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      await writeFile(originalPath, data, { mode: 0o600 });
      try {
        const result = await stage({
          name: input.name,
          originalPath,
          ownedOriginal: true,
        });
        const attachment = result.attachments[0];
        if (attachment?.mimeType !== input.mimeType) {
          if (attachment !== undefined) await discard([attachment.id]);
          throw new Error("Pasted image data does not match its image type.");
        }
        return result;
      } catch (error) {
        await rm(originalPath, { force: true });
        throw error;
      }
    },
    discard,
    async resolveOriginal(attachmentId) {
      const record = records.get(attachmentId);
      if (record === undefined) throw new Error("Draft image attachment not found.");
      const metadata = await stat(record.originalPath);
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_SOURCE_BYTES) {
        throw new Error("Draft image attachment is unavailable.");
      }
      return { path: record.originalPath, mimeType: record.mimeType };
    },
  };
}

async function inspectImage(path: string): Promise<{
  readonly metadata: Metadata;
  readonly mimeType: SupportedImageMimeType;
}> {
  const source = await stat(path);
  if (!source.isFile()) throw new Error(`Image attachment is not a file: ${path}`);
  if (source.size === 0 || source.size > MAX_SOURCE_BYTES) {
    throw new Error(`Image attachments must be 20 MiB or smaller: ${basename(path)}`);
  }
  const metadata = await sharp(path, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error(`Image dimensions are unavailable: ${basename(path)}`);
  }
  return { metadata, mimeType: imageMimeType(metadata) };
}

function shouldOptimize(size: number, metadata: Metadata): boolean {
  return (
    size > OPTIMIZED_TARGET_BYTES ||
    Math.max(metadata.width ?? 0, metadata.height ?? 0) > OPTIMIZED_MAX_EDGE ||
    metadata.format === "gif"
  );
}

async function createOptimizedImage(input: {
  readonly attachmentId: string;
  readonly metadata: Metadata;
  readonly sourcePath: string;
  readonly stagingRoot: string;
}): Promise<NonNullable<ExpertPromptAttachment["optimized"]>> {
  await mkdir(input.stagingRoot, { recursive: true, mode: 0o700 });
  const targetPath = join(input.stagingRoot, `${input.attachmentId}.optimized.webp`);
  const sourceEdge = Math.max(input.metadata.width ?? 0, input.metadata.height ?? 0);
  let edge = Math.min(OPTIMIZED_MAX_EDGE, sourceEdge);
  let output: Buffer | undefined;
  while (true) {
    for (let quality = 72; quality >= 40; quality -= 8) {
      output = await sharp(input.sourcePath, {
        page: 0,
        pages: 1,
        limitInputPixels: MAX_INPUT_PIXELS,
      })
        .rotate()
        .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (output.byteLength <= OPTIMIZED_TARGET_BYTES) break;
    }
    if (output !== undefined && output.byteLength <= OPTIMIZED_TARGET_BYTES) break;
    if (edge <= OPTIMIZED_MIN_EDGE) break;
    edge = Math.max(OPTIMIZED_MIN_EDGE, Math.floor(edge * 0.8));
  }
  if (output === undefined || output.byteLength > OPTIMIZED_TARGET_BYTES) {
    throw new Error(`Image could not be compressed below 1 MiB: ${basename(input.sourcePath)}`);
  }
  await writeFile(targetPath, output, { mode: 0o600 });
  return { path: targetPath, mimeType: "image/webp", size: output.byteLength };
}

async function createThumbnail(path: string): Promise<Buffer> {
  return await sharp(path, { page: 0, pages: 1, limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, { fit: "cover", position: "centre" })
    .webp({ quality: 58, effort: 3 })
    .toBuffer();
}

function imageMimeType(metadata: Metadata): SupportedImageMimeType {
  switch (metadata.format) {
    case "gif":
      return "image/gif";
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      throw new Error(`Unsupported image attachment type: ${metadata.format ?? "unknown"}`);
  }
}

function imageExtension(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
  }
}

async function discardOwnedPaths(paths: ReadonlySet<string>): Promise<void> {
  await Promise.allSettled([...paths].map(async (path) => await rm(path, { force: true })));
}
