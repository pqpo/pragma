import type { ExpertPromptAttachment } from "@pragma/shared";

import type {
  PickMissionAttachmentsResult,
  StageMissionClipboardImage,
} from "../../../shared/contracts/index.ts";

export const MAX_MISSION_ATTACHMENTS = 20;
const supportedClipboardImageTypes = new Set<StageMissionClipboardImage["mimeType"]>([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function mergeMissionAttachments(
  current: readonly ExpertPromptAttachment[],
  additions: readonly ExpertPromptAttachment[],
): readonly ExpertPromptAttachment[] | undefined {
  const known = new Set(current.map((attachment) => `${attachment.kind}:${attachment.path}`));
  const unique = additions.filter(
    (attachment) => !known.has(`${attachment.kind}:${attachment.path}`),
  );
  return current.length + unique.length > MAX_MISSION_ATTACHMENTS
    ? undefined
    : [...current, ...unique];
}

export function clipboardImageFile(data: DataTransfer): File | undefined {
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) return file;
  }
  return undefined;
}

export async function stageClipboardImage(
  file: File,
  stage: (input: StageMissionClipboardImage) => Promise<PickMissionAttachmentsResult>,
): Promise<PickMissionAttachmentsResult> {
  if (!supportedClipboardImageTypes.has(file.type as StageMissionClipboardImage["mimeType"])) {
    throw new Error(`Unsupported pasted image type: ${file.type || "unknown"}.`);
  }
  const mimeType = file.type as StageMissionClipboardImage["mimeType"];
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return await stage({
    name: file.name.trim() || `pasted-image.${imageExtension(mimeType)}`,
    mimeType,
    data: btoa(binary),
  });
}

function imageExtension(mimeType: StageMissionClipboardImage["mimeType"]): string {
  switch (mimeType) {
    case "image/gif":
      return "gif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
  }
}
