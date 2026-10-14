import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createControllerRunMissionPort,
  createLocalHostMissionEventProjector,
  createMissionControllerStore,
  createMissionQuery,
  createMissionWatchApplication,
  type LocalHostRunEvent,
} from "../src/index.ts";
import {
  MissionContentReferenceSchema,
  MissionContentReadSchema,
} from "@pragma/shared/integration";

it.each(
  [
    { name: "Unicode scalar", value: "中😀 output ".repeat(100) },
    { name: "JSON-encoded scalar", value: "\ud800".repeat(8) },
    {
      name: "ordinary event with result",
      value: { executionId: "22222222-2222-4222-8222-222222222222", result: "body".repeat(100) },
    },
  ].flatMap((test) => ["live", "watch"].map((channel) => ({ ...test, channel }))),
)("recovers the exact $name through $channel with durable metadata", async ({ value, channel }) => {
  const root = await mkdtemp(join(tmpdir(), "pragma-bounded-event-"));
  const missionId = "11111111-1111-4111-8111-111111111111";
  try {
    const controller = createMissionControllerStore({ missionsPath: root });
    const mission = createControllerRunMissionPort(controller);
    const guard = await mission.claim(missionId, "22222222-2222-4222-8222-222222222222");
    await mission.append(missionId, guard, "mission.created", {});
    const published: LocalHostRunEvent[] = [];
    const projector = createLocalHostMissionEventProjector({
      missionId,
      guard,
      mission,
      maxContentBytes: 32,
      onEvent: (event) => published.push(event),
    });
    projector.enqueue({ type: "run.progress", data: value });
    await projector.flush();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ missionId, replayable: true });
    const persisted = (await controller.readSnapshot({ missionId })).events.find(
      (event) => event.type === "run.progress",
    );
    expect(persisted?.eventId).toBeDefined();
    expect(published[0]!.eventId).toBe(persisted!.eventId);
    let output = published[0]!;
    if (channel === "watch") {
      const stop = new AbortController();
      stop.abort();
      await createMissionWatchApplication({ controller }).watch({
        missionId,
        maxContentBytes: 32,
        signal: stop.signal,
        onEvent: (event) => {
          if (event.type === "run.progress") output = event;
        },
      });
    }
    const reference = MissionContentReferenceSchema.parse(
      (output.data as Record<string, unknown>).contentReference,
    );
    expect(reference.source).toBe("event");
    const read = MissionContentReadSchema.parse(
      await createMissionQuery({ controller }).queryMission({
        missionId,
        view: "content",
        limit: 1,
        content: {
          source: "event",
          id: reference.id,
          fingerprint: reference.fingerprint,
          start: 0,
          maxBytes: 64000,
        },
      }),
    );
    expect(read.encoding === "utf8-json" ? JSON.parse(read.content) : read.content).toEqual(value);
    expect(output.occurredAt).toBe(persisted!.occurredAt);
    await expect(
      createMissionQuery({ controller }).queryMission({
        missionId,
        view: "content",
        limit: 1,
        content: {
          source: "queue",
          id: reference.id,
          fingerprint: reference.fingerprint,
          start: 0,
          maxBytes: 64000,
        },
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await mission.release(missionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
