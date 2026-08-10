import { pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { MISSION_ATTACHMENT_PREVIEW_SCHEME } from "../../../shared/contracts/index.ts";
import type { MissionStore } from "./mission-store.ts";
import {
  parseMissionAttachmentPreviewUrl,
  resolveMissionAttachmentImage,
} from "./mission-attachment-preview.ts";

let schemeRegistered = false;
let handlerInstalled = false;

export function registerMissionAttachmentScheme(): void {
  if (schemeRegistered) return;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MISSION_ATTACHMENT_PREVIEW_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
  schemeRegistered = true;
}

export function installMissionAttachmentProtocol(missions: MissionStore): void {
  if (handlerInstalled) return;
  if (missions.storagePath === undefined) {
    throw new Error("Mission attachment previews require a persistent Mission store.");
  }
  const previewSource = {
    getAttachments: missions.getAttachments.bind(missions),
    storagePath: missions.storagePath,
  };
  protocol.handle(MISSION_ATTACHMENT_PREVIEW_SCHEME, async (request) => {
    try {
      const { missionId, attachmentId } = parseMissionAttachmentPreviewUrl(request.url);
      const image = await resolveMissionAttachmentImage(previewSource, missionId, attachmentId);
      const fileResponse = await net.fetch(pathToFileURL(image.path).toString());
      if (!fileResponse.ok || fileResponse.body === null) {
        throw new Error("Mission image attachment could not be streamed.");
      }
      return new Response(fileResponse.body, {
        headers: {
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Type": image.mimeType,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Attachment preview unavailable.", { status: 404 });
    }
  });
  handlerInstalled = true;
}
