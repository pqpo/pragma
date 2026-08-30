import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMissionControllerStore,
  createMissionQuery,
  makeMissionEventCursor,
  type MissionControllerStore,
} from "../src/index.ts";
import { MissionEventsSchema, MissionSummarySchema } from "@pragma/shared/integration";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_MISSION_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_ID = "33333333-3333-4333-8333-333333333333";
const EXECUTION_ONE = "44444444-4444-4444-8444-444444444444";
const EXECUTION_TWO = "55555555-5555-4555-8555-555555555555";
const temporaryPaths: string[] = [];

describe("Mission query projections", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true })),
    );
  });

  it("projects a compact summary without returning the raw event stream", async () => {
    const controller = await createController();
    await appendEvents(controller, [
      [
        "mission.created",
        {
          executor: { kind: "expert", id: "aaaaaaaaaaaaaaaa" },
          workspace: "/workspace/project",
        },
      ],
      ["run.started", { executionId: EXECUTION_ONE }],
    ]);

    const summary = MissionSummarySchema.parse(
      await createMissionQuery({ controller }).queryMission({
        missionId: MISSION_ID,
        view: "summary",
        limit: 50,
      }),
    );
    expect(summary).toMatchObject({
      schemaVersion: "pragma.mission-summary/v1",
      missionId: MISSION_ID,
      status: "running",
      lifecycleStatus: "active",
      executor: { kind: "expert", id: "aaaaaaaaaaaaaaaa" },
      execution: { id: EXECUTION_ONE, status: "running" },
      workspace: { canonicalPath: "/workspace/project" },
      eventSequence: 2,
    });
    expect(summary).not.toHaveProperty("events");
  });

  it("anchors result to the latest run and does not expose an earlier success", async () => {
    const controller = await createController();
    await appendEvents(controller, [
      ["mission.created", { executor: { kind: "expert", id: "aaaaaaaaaaaaaaaa" } }],
      ["run.started", { executionId: EXECUTION_ONE }],
      ["run.succeeded", { executionId: EXECUTION_ONE, result: { turn: 1 } }],
      ["run.accepted", { requestId: "66666666-6666-4666-8666-666666666666" }],
      ["run.started", { executionId: EXECUTION_TWO }],
    ]);

    const query = createMissionQuery({ controller });
    await expect(
      query.queryMission({ missionId: MISSION_ID, view: "result", limit: 50 }),
    ).resolves.toMatchObject({
      schemaVersion: "pragma.mission-result/v1",
      missionId: MISSION_ID,
      executionId: EXECUTION_TWO,
      status: "running",
      available: false,
    });
    const result = await query.queryMission({ missionId: MISSION_ID, view: "result", limit: 50 });
    expect(result).not.toHaveProperty("result");
  });

  it("projects the latest succeeded execution result and usage", async () => {
    const controller = await createController();
    await appendEvents(controller, [
      ["mission.created", { executor: { kind: "expert", id: "aaaaaaaaaaaaaaaa" } }],
      ["run.started", { executionId: EXECUTION_ONE }],
      [
        "run.succeeded",
        {
          executionId: EXECUTION_ONE,
          result: { answer: 42 },
          usage: {
            measurement: "reported",
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ],
    ]);

    await expect(
      createMissionQuery({ controller }).queryMission({
        missionId: MISSION_ID,
        view: "result",
        limit: 50,
      }),
    ).resolves.toMatchObject({
      executionId: EXECUTION_ONE,
      status: "succeeded",
      available: true,
      result: { answer: 42 },
      usage: { totalTokens: 3 },
    });
  });

  it.each([
    {
      name: "waiting",
      type: "run.input_required",
      data: {
        executionId: EXECUTION_ONE,
        interaction: {
          schemaVersion: "pragma.human-interaction/v1",
          kind: "request",
          missionId: MISSION_ID,
          executionId: EXECUTION_ONE,
          interactionId: "interaction-1",
          sensitive: false,
          interaction: {
            kind: "question",
            prompt: "Choose an option",
            questions: [],
          },
        },
      },
    },
    {
      name: "failed",
      type: "run.failed",
      data: {
        executionId: EXECUTION_ONE,
        error: {
          schemaVersion: "pragma.integration-error/v1",
          code: "EXECUTION_FAILED",
          category: "execution",
          message: "fixture failed",
          retryable: false,
        },
      },
    },
    {
      name: "interrupted",
      type: "run.interrupted",
      data: { executionId: EXECUTION_ONE },
    },
  ] as const)("projects a %s execution state", async ({ name, type, data }) => {
    const controller = await createController();
    await appendEvents(controller, [
      ["mission.created", { executor: { kind: "expert", id: "aaaaaaaaaaaaaaaa" } }],
      ["run.started", { executionId: EXECUTION_ONE }],
      [type, data],
    ]);

    await expect(
      createMissionQuery({ controller }).queryMission({
        missionId: MISSION_ID,
        view: "result",
        limit: 50,
      }),
    ).resolves.toMatchObject({
      status: name,
      available: false,
      executionId: EXECUTION_ONE,
    });
  });

  it("pages events by durable sequence cursors and rejects foreign or offset cursors", async () => {
    const controller = await createController();
    await appendEvents(controller, [
      ["mission.created", { executor: { kind: "expert", id: "aaaaaaaaaaaaaaaa" } }],
      ["run.started", { executionId: EXECUTION_ONE }],
      ["run.progress", { executionId: EXECUTION_ONE, progress: 1 }],
      ["run.succeeded", { executionId: EXECUTION_ONE, result: { ok: true } }],
    ]);
    const query = createMissionQuery({ controller });

    const first = MissionEventsSchema.parse(
      await query.queryMission({ missionId: MISSION_ID, view: "events", limit: 1 }),
    );
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.sequence).toBe(1);
    expect(first.nextCursor).toBe(makeMissionEventCursor(MISSION_ID, 1));

    const second = MissionEventsSchema.parse(
      await query.queryMission({
        missionId: MISSION_ID,
        view: "events",
        limit: 2,
        cursor: first.nextCursor,
      }),
    );
    expect(second.items.map((item) => item.sequence)).toEqual([2, 3]);
    expect(second.nextCursor).toBe(makeMissionEventCursor(MISSION_ID, 3));

    const last = MissionEventsSchema.parse(
      await query.queryMission({
        missionId: MISSION_ID,
        view: "events",
        limit: 10,
        cursor: second.nextCursor,
      }),
    );
    expect(last.items.map((item) => item.sequence)).toEqual([4]);
    expect(last).not.toHaveProperty("nextCursor");

    await expect(
      query.queryMission({
        missionId: MISSION_ID,
        view: "events",
        limit: 1,
        cursor: `pragma.cli.cursor.v1.${Buffer.from(JSON.stringify({ offset: 1 }), "utf8").toString("base64url")}`,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(
      query.queryMission({
        missionId: MISSION_ID,
        view: "events",
        limit: 1,
        cursor: makeMissionEventCursor(OTHER_MISSION_ID, 1),
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("forwards retention gaps as CURSOR_EXPIRED", async () => {
    const path = await mkdtemp(join(tmpdir(), "pragma-mission-query-expired-"));
    temporaryPaths.push(path);
    const controller = createMissionControllerStore({ missionsPath: join(path, "missions") });
    await appendEvents(controller, [
      ["mission.created", { executor: { kind: "expert", id: "aaaaaaaaaaaaaaaa" } }],
      ["output.delta", { value: "old" }],
      ["output.delta", { value: "new" }],
    ]);
    const compactController = createMissionControllerStore({
      missionsPath: join(path, "missions"),
      retention: { events: { maxCount: 1 } },
    });
    await compactController.compactRetention({ missionId: MISSION_ID });

    const query = createMissionQuery({ controller: compactController });
    await expect(
      query.queryMission({
        missionId: MISSION_ID,
        view: "events",
        limit: 1,
        cursor: makeMissionEventCursor(MISSION_ID, 1),
      }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it.each(["chat", "work"] as const)("fails loudly for unsupported %s view", async (view) => {
    const query = createMissionQuery({ controller: await createController() });
    await expect(
      query.queryMission({ missionId: MISSION_ID, view, limit: 50 }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { view, supportedViews: ["summary", "result", "events"] },
    });
  });
});

async function createController(): Promise<MissionControllerStore> {
  const path = await mkdtemp(join(tmpdir(), "pragma-mission-query-"));
  temporaryPaths.push(path);
  return createMissionControllerStore({ missionsPath: path });
}

async function appendEvents(
  controller: MissionControllerStore,
  events: readonly (readonly [string, Record<string, unknown>])[],
): Promise<void> {
  const guard = await controller.claim({
    missionId: MISSION_ID,
    claimId: CLAIM_ID,
    leaseMs: 10_000,
  });
  await controller.write({
    missionId: MISSION_ID,
    guard,
    operation: async ({ appendEvent }) => {
      for (const [type, data] of events) await appendEvent(type, data);
    },
  });
  await controller.release({ missionId: MISSION_ID, guard });
}
