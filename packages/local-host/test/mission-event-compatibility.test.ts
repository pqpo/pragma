import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MissionEventSchema,
  MissionEventTransactionSchema,
  createMissionControllerStore,
} from "../src/index.ts";

const missionId = "00000000-0000-4000-8000-000000000101";
const eventId = "00000000-0000-4000-8000-000000000102";

const pinnedData = {
  schemaVersion: "pragma.mission-pinned-binding/v1",
  requestId: "00000000-0000-4000-8000-000000000103",
  payloadHash: `sha256:${"a".repeat(64)}`,
  command: "expert.run",
  executor: {
    source: "project",
    ref: { kind: "expert", id: "0123456789abcdef" },
    project: {
      projectId: "studio",
      revision: 1,
      fingerprint: "b".repeat(64),
    },
  },
  workspace: {
    canonicalPath: "/workspace",
    identityHash: `sha256:${"c".repeat(64)}`,
  },
  provenance: "new_run",
} as const;

describe("MissionEvent v1 pinned binding compatibility", () => {
  it("keeps the existing v1 event parser open for mission.binding.pinned", () => {
    const event = MissionEventSchema.parse({
      schemaVersion: "pragma.local-host-mission-event/v1",
      eventId,
      missionId,
      sequence: 1,
      occurredAt: "2026-08-27T00:00:00.000Z",
      type: "mission.binding.pinned",
      data: pinnedData,
    });

    expect(event.type).toBe("mission.binding.pinned");
    expect(event.data).toEqual(pinnedData);
    expect(
      MissionEventTransactionSchema.parse({
        schemaVersion: "pragma.local-host-mission-event-transaction/v1",
        missionId,
        event,
      }).event,
    ).toEqual(event);
  });

  it("reads a v1 JSONL event log containing the open event without changing storage versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-event-compatibility-"));
    try {
      const missionsPath = join(root, "missions");
      const missionRoot = join(missionsPath, missionId, "local-host");
      await mkdir(missionRoot, { recursive: true });
      await writeFile(
        join(missionRoot, "events.jsonl"),
        `${JSON.stringify({
          schemaVersion: "pragma.local-host-mission-event/v1",
          eventId,
          missionId,
          sequence: 1,
          occurredAt: "2026-08-27T00:00:00.000Z",
          type: "mission.binding.pinned",
          data: pinnedData,
        })}\n`,
      );
      const store = createMissionControllerStore({ missionsPath });
      // The direct parser assertion above is the compatibility lock. This
      // second assertion exercises the M7 reader path as well; a future reader
      // must continue to ignore the new event's meaning unless it opts into the
      // pinned-binding contract explicitly.
      await expect(store.readSnapshot({ missionId })).resolves.toMatchObject({
        snapshot: {
          schemaVersion: "pragma.local-host-mission-aggregate/v1",
          eventSequence: 0,
        },
        events: [{ type: "mission.binding.pinned", eventId }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
