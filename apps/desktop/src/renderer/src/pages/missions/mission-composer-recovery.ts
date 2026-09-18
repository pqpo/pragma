import type { ExpertPromptAttachment } from "@pragma/shared";

export const MAX_MISSION_COMPOSER_RECOVERIES = 8;

export interface MissionComposerSnapshot {
  readonly missionId: string;
  readonly draft: string;
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly attachmentPreviews: Readonly<Record<string, string>>;
}

export type MissionComposerRestoreDecision =
  "already-owned" | "restore" | "conflict" | "wrong-mission";

export function resolveMissionComposerRestore(input: {
  readonly current: MissionComposerSnapshot;
  readonly recovery: MissionComposerSnapshot;
}): MissionComposerRestoreDecision {
  if (input.current.missionId !== input.recovery.missionId) return "wrong-mission";
  if (
    input.current.draft === input.recovery.draft &&
    sameAttachmentIds(input.current.attachments, input.recovery.attachments)
  ) {
    return "already-owned";
  }
  return input.current.draft === "" && input.current.attachments.length === 0
    ? "restore"
    : "conflict";
}

export function storeMissionComposerRecovery(
  recoveries: Map<string, MissionComposerSnapshot>,
  snapshot: MissionComposerSnapshot,
  limit = MAX_MISSION_COMPOSER_RECOVERIES,
): readonly string[] {
  const releasedCandidates: string[] = [];
  const previous = recoveries.get(snapshot.missionId);
  if (previous !== undefined) {
    releasedCandidates.push(...attachmentIds(previous));
    recoveries.delete(snapshot.missionId);
  }

  if (snapshot.draft !== "" || snapshot.attachments.length > 0) {
    recoveries.set(snapshot.missionId, snapshot);
  }

  while (recoveries.size > Math.max(0, limit)) {
    const oldestMissionId = recoveries.keys().next().value as string | undefined;
    if (oldestMissionId === undefined) break;
    const evicted = recoveries.get(oldestMissionId);
    recoveries.delete(oldestMissionId);
    if (evicted !== undefined) releasedCandidates.push(...attachmentIds(evicted));
  }

  return unownedAttachmentIds(recoveries, releasedCandidates);
}

export function discardMissionComposerRecovery(
  recoveries: Map<string, MissionComposerSnapshot>,
  missionId: string,
): readonly string[] {
  const recovery = recoveries.get(missionId);
  if (recovery === undefined) return [];
  recoveries.delete(missionId);
  return unownedAttachmentIds(recoveries, attachmentIds(recovery));
}

export function clearMissionComposerRecoveries(
  recoveries: Map<string, MissionComposerSnapshot>,
): readonly string[] {
  const attachmentIdsToRelease = [...recoveries.values()].flatMap(attachmentIds);
  recoveries.clear();
  return [...new Set(attachmentIdsToRelease)];
}

function sameAttachmentIds(
  left: readonly ExpertPromptAttachment[],
  right: readonly ExpertPromptAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}

function attachmentIds(snapshot: MissionComposerSnapshot): string[] {
  return snapshot.attachments.map((attachment) => attachment.id);
}

function unownedAttachmentIds(
  recoveries: ReadonlyMap<string, MissionComposerSnapshot>,
  candidates: readonly string[],
): readonly string[] {
  if (candidates.length === 0) return [];
  const retained = new Set(
    [...recoveries.values()].flatMap((snapshot) => snapshot.attachments.map(({ id }) => id)),
  );
  return [...new Set(candidates)].filter((attachmentId) => !retained.has(attachmentId));
}
