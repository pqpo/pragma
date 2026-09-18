import type { ExpertPromptAttachment } from "@pragma/shared";

export const MAX_MISSION_COMPOSER_RECOVERIES = 8;

export interface MissionComposerSnapshot {
  readonly missionId: string;
  readonly revisionId: string;
  readonly draft: string;
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly attachmentPreviews: Readonly<Record<string, string>>;
}

export type MissionComposerSnapshotIdentity = Pick<
  MissionComposerSnapshot,
  "missionId" | "revisionId"
>;
export type MissionComposerRecoveryWriteReason = "unmount" | "send-failed";
export type MissionComposerRecoveryConsumeReason = "claimed" | "send-succeeded";

export type MissionComposerRestoreDecision =
  "already-owned" | "restore" | "conflict" | "wrong-mission";

export function resolveMissionComposerRestore(input: {
  readonly current: MissionComposerSnapshot;
  readonly recovery: MissionComposerSnapshot;
}): MissionComposerRestoreDecision {
  if (input.current.missionId !== input.recovery.missionId) return "wrong-mission";
  if (input.current.revisionId !== input.recovery.revisionId) return "conflict";
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

export function isCurrentMissionComposerSnapshot(
  latestRevisionId: string | undefined,
  snapshot: MissionComposerSnapshotIdentity,
): boolean {
  return latestRevisionId === undefined || latestRevisionId === snapshot.revisionId;
}

export function canStoreFailedMissionComposerRecovery(
  recoveries: ReadonlyMap<string, MissionComposerSnapshot>,
  latestRevisionId: string | undefined,
  snapshot: MissionComposerSnapshot,
): boolean {
  if (!isCurrentMissionComposerSnapshot(latestRevisionId, snapshot)) return false;
  const existing = recoveries.get(snapshot.missionId);
  return (
    existing === undefined ||
    resolveMissionComposerRestore({ current: existing, recovery: snapshot }) !== "conflict"
  );
}

export function consumeMissionComposerRecovery(
  recoveries: Map<string, MissionComposerSnapshot>,
  snapshot: MissionComposerSnapshot,
): boolean {
  const recovery = recoveries.get(snapshot.missionId);
  if (recovery === undefined || !sameMissionComposerSnapshot(recovery, snapshot)) return false;
  recoveries.delete(snapshot.missionId);
  return true;
}

export function releaseMissionComposerSnapshot(
  recoveries: ReadonlyMap<string, MissionComposerSnapshot>,
  snapshot: MissionComposerSnapshot,
): readonly string[] {
  return unownedAttachmentIds(recoveries, attachmentIds(snapshot));
}

export function replaceMissionComposerSnapshotDraft(input: {
  readonly snapshot: MissionComposerSnapshot;
  readonly expectedRevisionId: string;
  readonly nextRevisionId: string;
  readonly draft: string;
}): MissionComposerSnapshot | undefined {
  if (input.snapshot.revisionId !== input.expectedRevisionId) return undefined;
  return {
    ...input.snapshot,
    revisionId: input.nextRevisionId,
    draft: input.draft,
  };
}

export function discardMissionComposerRecoverySnapshot(
  recoveries: Map<string, MissionComposerSnapshot>,
  snapshot: MissionComposerSnapshot,
): readonly string[] {
  const recovery = recoveries.get(snapshot.missionId);
  if (recovery === undefined || !sameMissionComposerSnapshot(recovery, snapshot)) return [];
  recoveries.delete(snapshot.missionId);
  return unownedAttachmentIds(recoveries, attachmentIds(recovery));
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

function sameMissionComposerSnapshot(
  left: MissionComposerSnapshot,
  right: MissionComposerSnapshot,
): boolean {
  return (
    left.missionId === right.missionId &&
    left.revisionId === right.revisionId &&
    left.draft === right.draft &&
    sameAttachmentIds(left.attachments, right.attachments)
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
