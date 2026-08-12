import type { ExpertPromptAttachment } from "@pragma/shared";

import type {
  DesktopRuntimeModel,
  MissionModelOverride,
  PickMissionAttachmentsResult,
  StageMissionClipboardImage,
} from "../../../shared/contracts/index.ts";

export const MAX_MISSION_ATTACHMENTS = 20;
export type MissionImageSupport = "supported" | "unsupported" | "unknown";
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
  const unique = additions.filter((attachment) => {
    const key = `${attachment.kind}:${attachment.path}`;
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  return current.length + unique.length > MAX_MISSION_ATTACHMENTS
    ? undefined
    : [...current, ...unique];
}

export function missionImageSupport(
  models: readonly DesktopRuntimeModel[],
  override: MissionModelOverride | undefined,
  defaultSelection: MissionModelOverride | undefined,
): MissionImageSupport {
  const selection = override ?? defaultSelection;
  const model =
    selection === undefined
      ? models.find((candidate) => candidate.default === true)
      : models.find(
          (candidate) =>
            candidate.provider.id === selection.providerId && candidate.id === selection.modelId,
        );
  if (model?.inputModalities === undefined) return "unknown";
  return model.inputModalities.includes("image") ? "supported" : "unsupported";
}

export function mergeMissionAttachmentPreviews(
  current: Readonly<Record<string, string>>,
  result: PickMissionAttachmentsResult,
  accepted: readonly ExpertPromptAttachment[],
): Readonly<Record<string, string>> {
  const acceptedIds = new Set(accepted.map((attachment) => attachment.id));
  return Object.fromEntries([
    ...Object.entries(current),
    ...result.previews
      .filter((preview) => acceptedIds.has(preview.attachmentId))
      .map((preview) => [preview.attachmentId, preview.dataUrl] as const),
  ]);
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
