import { describe, expect, it } from "vitest";

import {
  MAX_MISSION_COMPOSER_RECOVERIES,
  clearMissionComposerRecoveries,
  discardMissionComposerRecovery,
  resolveMissionComposerRestore,
  storeMissionComposerRecovery,
  type MissionComposerSnapshot,
} from "./mission-composer-recovery.ts";

describe("Mission composer recovery", () => {
  it("restores only into a pristine Composer and never overwrites newer input", () => {
    const recovery = snapshot("mission-a", "failed send", ["attachment-old"]);

    expect(
      resolveMissionComposerRestore({ current: snapshot("mission-a", "", []), recovery }),
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
});

function snapshot(
  missionId: string,
  draft: string,
  attachmentIds: readonly string[],
): MissionComposerSnapshot {
  return {
    missionId,
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
