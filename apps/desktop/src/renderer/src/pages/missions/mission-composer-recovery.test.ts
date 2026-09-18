import { describe, expect, it } from "vitest";

import {
  MAX_MISSION_COMPOSER_RECOVERIES,
  canStoreFailedMissionComposerRecovery,
  clearMissionComposerRecoveries,
  consumeMissionComposerRecovery,
  discardMissionComposerRecovery,
  discardMissionComposerRecoverySnapshot,
  isCurrentMissionComposerSnapshot,
  releaseMissionComposerSnapshot,
  replaceMissionComposerSnapshotDraft,
  resolveMissionComposerRestore,
  storeMissionComposerRecovery,
  type MissionComposerSnapshot,
} from "./mission-composer-recovery.ts";

describe("Mission composer recovery", () => {
  it("restores only into a pristine Composer and never overwrites newer input", () => {
    const recovery = snapshot("mission-a", "failed send", ["attachment-old"]);

    expect(
      resolveMissionComposerRestore({
        current: snapshot("mission-a", "", [], recovery.revisionId),
        recovery,
      }),
    ).toBe("restore");
    expect(resolveMissionComposerRestore({ current: recovery, recovery })).toBe("already-owned");
    expect(
      resolveMissionComposerRestore({
        current: snapshot("mission-a", "new user input", ["attachment-new"]),
        recovery,
      }),
    ).toBe("conflict");
    expect(
      resolveMissionComposerRestore({ current: snapshot("mission-b", "", []), recovery }),
    ).toBe("wrong-mission");
  });

  it("releases replaced and removed attachment ownership without releasing retained ids", () => {
    const recoveries = new Map<string, MissionComposerSnapshot>();
    storeMissionComposerRecovery(
      recoveries,
      snapshot("mission-a", "first", ["attachment-kept", "attachment-old"]),
    );

    expect(
      storeMissionComposerRecovery(
        recoveries,
        snapshot("mission-a", "second", ["attachment-kept", "attachment-new"]),
      ),
    ).toEqual(["attachment-old"]);
    expect(storeMissionComposerRecovery(recoveries, snapshot("mission-a", "", []))).toEqual([
      "attachment-kept",
      "attachment-new",
    ]);
    expect(recoveries.size).toBe(0);
  });

  it("bounds inactive Mission recoveries and releases evicted attachments", () => {
    const recoveries = new Map<string, MissionComposerSnapshot>();
    for (let index = 0; index < MAX_MISSION_COMPOSER_RECOVERIES; index += 1) {
      storeMissionComposerRecovery(
        recoveries,
        snapshot(`mission-${String(index)}`, "draft", [`attachment-${String(index)}`]),
      );
    }

    expect(
      storeMissionComposerRecovery(
        recoveries,
        snapshot("mission-new", "draft", ["attachment-new"]),
      ),
    ).toEqual(["attachment-0"]);
    expect(recoveries.size).toBe(MAX_MISSION_COMPOSER_RECOVERIES);
    expect(recoveries.has("mission-0")).toBe(false);
  });

  it("returns attachment ids when one or all recoveries are discarded", () => {
    const recoveries = new Map<string, MissionComposerSnapshot>([
      ["mission-a", snapshot("mission-a", "a", ["attachment-a"])],
      ["mission-b", snapshot("mission-b", "b", ["attachment-b"])],
    ]);

    expect(discardMissionComposerRecovery(recoveries, "mission-a")).toEqual(["attachment-a"]);
    expect(clearMissionComposerRecoveries(recoveries)).toEqual(["attachment-b"]);
    expect(recoveries.size).toBe(0);
  });

  it("does not let an older failed send replace a newer inactive draft", () => {
    const oldAttempt = snapshot("mission-a", "old send", ["attachment-old"], "revision-old");
    const newerDraft = snapshot("mission-a", "new draft", ["attachment-new"], "revision-new");
    const recoveries = new Map<string, MissionComposerSnapshot>();
    storeMissionComposerRecovery(recoveries, newerDraft);

    expect(isCurrentMissionComposerSnapshot(newerDraft.revisionId, oldAttempt)).toBe(false);
    expect(
      canStoreFailedMissionComposerRecovery(recoveries, newerDraft.revisionId, oldAttempt),
    ).toBe(false);
    expect(releaseMissionComposerSnapshot(recoveries, oldAttempt)).toEqual(["attachment-old"]);
    expect(recoveries.get("mission-a")).toBe(newerDraft);
  });

  it("does not treat different send snapshots with the same revision as the same owner", () => {
    const activeDraft = snapshot("mission-a", "new draft", ["attachment-new"], "revision-shared");
    const retryFailure = snapshot("mission-a", "old retry", ["attachment-old"], "revision-shared");
    const recoveries = new Map<string, MissionComposerSnapshot>([["mission-a", activeDraft]]);

    expect(
      canStoreFailedMissionComposerRecovery(recoveries, activeDraft.revisionId, retryFailure),
    ).toBe(false);
    expect(consumeMissionComposerRecovery(recoveries, retryFailure)).toBe(false);
    expect(discardMissionComposerRecoverySnapshot(recoveries, retryFailure)).toEqual([]);
    expect(recoveries.get("mission-a")).toBe(activeDraft);
  });

  it("consumes or discards only the exact recovery revision", () => {
    const newerDraft = snapshot("mission-a", "new draft", ["attachment-new"], "revision-new");
    const recoveries = new Map<string, MissionComposerSnapshot>([["mission-a", newerDraft]]);

    expect(
      consumeMissionComposerRecovery(
        recoveries,
        snapshot("mission-a", "old draft", [], "revision-old"),
      ),
    ).toBe(false);
    expect(
      discardMissionComposerRecoverySnapshot(
        recoveries,
        snapshot("mission-a", "old draft", [], "revision-old"),
      ),
    ).toEqual([]);
    expect(recoveries.get("mission-a")).toBe(newerDraft);
    expect(consumeMissionComposerRecovery(recoveries, newerDraft)).toBe(true);
    expect(recoveries.has("mission-a")).toBe(false);
  });

  it("keeps a newer empty user intent newer than an old failed send", () => {
    const oldAttempt = snapshot("mission-a", "old send", [], "revision-old");
    const cleared = snapshot("mission-a", "", [], "revision-cleared");

    expect(isCurrentMissionComposerSnapshot("revision-cleared", oldAttempt)).toBe(false);
    expect(resolveMissionComposerRestore({ current: cleared, recovery: oldAttempt })).toBe(
      "conflict",
    );
  });

  it("replaces a removed queued draft only when the unmounted revision still matches", () => {
    const unmounted = snapshot("mission-a", "newer draft", ["attachment-a"], "revision-a");

    expect(
      replaceMissionComposerSnapshotDraft({
        snapshot: unmounted,
        expectedRevisionId: "revision-a",
        nextRevisionId: "revision-queued",
        draft: "removed queued message",
      }),
    ).toEqual({
      ...unmounted,
      revisionId: "revision-queued",
      draft: "removed queued message",
    });
    expect(
      replaceMissionComposerSnapshotDraft({
        snapshot: unmounted,
        expectedRevisionId: "revision-older",
        nextRevisionId: "revision-queued",
        draft: "removed queued message",
      }),
    ).toBeUndefined();
  });
});

function snapshot(
  missionId: string,
  draft: string,
  attachmentIds: readonly string[],
  revisionId = `revision-${missionId}-${draft}`,
): MissionComposerSnapshot {
  return {
    missionId,
    revisionId,
    draft,
    attachments: attachmentIds.map((id) => ({
      id,
      kind: "file" as const,
      name: `${id}.txt`,
      path: `/tmp/${id}.txt`,
    })),
    attachmentPreviews: {},
  };
}
