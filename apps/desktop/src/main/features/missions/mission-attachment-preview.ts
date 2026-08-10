import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  MISSION_ATTACHMENT_PREVIEW_SCHEME,
  MissionIdSchema,
} from "../../../shared/contracts/index.ts";
import type { MissionStore } from "./mission-store.ts";

const SUPPORTED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export async function resolveMissionAttachmentImage(
  missions: {
    readonly getAttachments: MissionStore["getAttachments"];
    readonly storagePath: NonNullable<MissionStore["storagePath"]>;
  },
  missionIdInput: string,
  attachmentId: string,
): Promise<{ readonly path: string; readonly mimeType: string }> {
  const missionId = MissionIdSchema.parse(missionIdInput);
  const attachment = (await missions.getAttachments(missionId)).find(
    (candidate) => candidate.id === attachmentId,
  );
  if (
    attachment?.kind !== "image" ||
    attachment.mimeType === undefined ||
    !SUPPORTED_IMAGE_TYPES.has(attachment.mimeType)
  ) {
    throw new Error("Mission image attachment not found.");
  }

  const missionRoot = await realpath(missions.storagePath(missionId));
  const imageRoot = await realpath(resolve(missionRoot, "attachments", "images"));
  const imagePath = await realpath(attachment.path);
  const relativePath = relative(imageRoot, imagePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Mission image attachment escaped its owner directory.");
  }
  const metadata = await stat(imagePath);
  if (!metadata.isFile() || metadata.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error("Mission image attachment is unavailable.");
  }
  return { path: imagePath, mimeType: attachment.mimeType };
}

export function parseMissionAttachmentPreviewUrl(url: string): {
  readonly missionId: string;
  readonly attachmentId: string;
} {
  const parsed = new URL(url);
  if (
    parsed.protocol !== `${MISSION_ATTACHMENT_PREVIEW_SCHEME}:` ||
    parsed.hostname !== "preview" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Invalid Mission attachment preview URL.");
  }
  const rawSegments = parsed.pathname.split("/");
  if (
    rawSegments.length !== 3 ||
    rawSegments[0] !== "" ||
    rawSegments[1] === "" ||
    rawSegments[2] === ""
  ) {
    throw new Error("Invalid Mission attachment preview URL.");
  }
  const segments = rawSegments.slice(1).map((segment) => decodeURIComponent(segment));
  return {
    missionId: MissionIdSchema.parse(segments[0]),
    attachmentId: segments[1]!,
  };
}
