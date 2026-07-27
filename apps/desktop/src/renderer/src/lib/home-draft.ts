import { z } from "zod";

import {
  DesktopToolPermissionModeSchema,
  MissionModelOverrideSchema,
} from "../../../shared/desktop-api.ts";

const homeDraftStorageKey = "pragma.desktop.home.draft.v1";

const HomeDraftSchema = z.object({
  executorRef: z.string().min(1),
  workspaceOverride: z
    .object({
      path: z.string().min(1),
      basename: z.string().min(1),
    })
    .optional(),
  goal: z.string().max(100_000),
  flowInput: z.record(z.string(), z.unknown()),
  toolPermissionMode: DesktopToolPermissionModeSchema,
  modelOverride: MissionModelOverrideSchema.optional(),
});

export type HomeDraft = z.infer<typeof HomeDraftSchema>;

type HomeDraftReader = Pick<Storage, "getItem">;
type HomeDraftWriter = Pick<Storage, "setItem">;

export function readHomeDraft(storage: HomeDraftReader | undefined): HomeDraft | undefined {
  try {
    const value = storage?.getItem(homeDraftStorageKey);
    if (value === undefined || value === null) return undefined;
    const parsed = HomeDraftSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeHomeDraft(storage: HomeDraftWriter | undefined, draft: HomeDraft): void {
  try {
    storage?.setItem(homeDraftStorageKey, JSON.stringify(HomeDraftSchema.parse(draft)));
  } catch {
    // Home remains usable when browser storage is unavailable or full.
  }
}
