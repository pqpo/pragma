import type { MissionChatUpdate } from "../../../../shared/contracts/index.ts";

export const MISSION_CHAT_PENDING_UPDATE_LIMIT = 256;
export const MISSION_CHAT_PENDING_BYTE_LIMIT = 1_024 * 1_024;

export function enqueueMissionChatUpdate(
  pending: readonly MissionChatUpdate[],
  pendingBytes: number,
  update: MissionChatUpdate,
): {
  readonly pending: readonly MissionChatUpdate[];
  readonly pendingBytes: number;
  readonly overflowed: boolean;
} {
  const updateBytes = estimateMissionChatUpdateBytes(update);
  if (
    pending.length >= MISSION_CHAT_PENDING_UPDATE_LIMIT ||
    pendingBytes + updateBytes > MISSION_CHAT_PENDING_BYTE_LIMIT
  ) {
    return updateBytes <= MISSION_CHAT_PENDING_BYTE_LIMIT
      ? { pending: [update], pendingBytes: updateBytes, overflowed: true }
      : { pending: [], pendingBytes: 0, overflowed: true };
  }
  return {
    pending: [...pending, update],
    pendingBytes: pendingBytes + updateBytes,
    overflowed: false,
  };
}

export function estimateMissionChatUpdatesBytes(updates: readonly MissionChatUpdate[]): number {
  return updates.reduce((total, update) => total + estimateMissionChatUpdateBytes(update), 0);
}

function estimateMissionChatUpdateBytes(update: MissionChatUpdate): number {
  if (update.kind === "invalidate") return 64;
  return update.patches.reduce((total, patch) => {
    if (patch.type === "entry.append") return total + patch.delta.length * 2 + 64;
    if (patch.type === "entry.upsert") {
      const content = "content" in patch.entry ? patch.entry.content.length : 0;
      const preview = patch.entry.kind === "tool" ? (patch.entry.outputPreview?.length ?? 0) : 0;
      return total + (content + preview) * 2 + 256;
    }
    return total + 128;
  }, 64);
}
