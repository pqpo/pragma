import { describe, expect, it, vi } from "vitest";

import { type MissionWatchRequest, type MissionWatchResult } from "@pragma/local-host";
import { CliEventV2StreamSchema } from "@pragma/local-host/wire";

import { runCli, type CliIo, type CliLocalHost } from "../src/index.ts";
import { CliParseError, parseCliArgv } from "../src/parser/argv.ts";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const CURSOR =
  "eyJtaXNzaW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJzZXF1ZW5jZSI6MX0";

describe("M8 mission watch command", () => {
  it("parses replay/after/until and rejects the unsupported json format", () => {
    expect(
      parseCliArgv([
        "mission",
        "watch",
        MISSION_ID,
        "--after",
        CURSOR,
        "--until",
        "input-required",
        "--format=jsonl",
      ]).command,
    ).toEqual({
      kind: "mission-watch",
      missionId: MISSION_ID,
      after: CURSOR,
      until: "input-required",
    });
    expect(parseCliArgv(["mission", "watch", MISSION_ID, "--replay", "0"]).command).toMatchObject({
      kind: "mission-watch",
      replay: 0,
    });
    expect(() =>
      parseCliArgv(["mission", "watch", MISSION_ID, "--after", CURSOR, "--replay", "1"]),
    ).toThrow("either --after or --replay");
    try {
      parseCliArgv(["--format=json", "mission", "watch", MISSION_ID]);
      throw new Error("expected an invalid-format parse error");
    } catch (error) {
      expect(error).toBeInstanceOf(CliParseError);
      expect((error as CliParseError).error.code).toBe("INVALID_FORMAT");
    }
  });

  it("preserves durable eventId/cursor and emits detached plus one stream.end", async () => {
    const io = createIo();
    let interrupt: (() => void) | undefined;
    const watchMission = vi.fn(async (input: MissionWatchRequest): Promise<MissionWatchResult> => {
      await input.onEvent({
        type: "run.progress",
        data: { message: "hello" },
        missionId: MISSION_ID,
        eventId: EVENT_ID,
        occurredAt: "2026-08-27T00:00:01.000Z",
        replayable: true,
        cursor: CURSOR,
      });
      await input.onEvent({
        type: "mission.snapshot",
        data: { missionId: MISSION_ID, status: "running", cursor: CURSOR },
        missionId: MISSION_ID,
        replayable: false,
      });
      await input.onEvent({
        type: "watch.ready",
        data: {
          missionId: MISSION_ID,
          cursor: CURSOR,
          barrierSequence: 1,
          replayed: 1,
          following: true,
        },
        missionId: MISSION_ID,
        replayable: false,
      });
      interrupt?.();
      expect(input.signal?.aborted).toBe(true);
      return {
        missionId: MISSION_ID,
        status: "detached",
        missionContinues: true,
        lastCursor: CURSOR,
      };
    });
    const exitCode = await runCli(
      ["mission", "watch", MISSION_ID, "--replay", "0", "--format=jsonl"],
      io,
      {
        localHost: { watchMission } as unknown as CliLocalHost,
        signals: {
          onInterrupt: (handler) => {
            interrupt = handler;
            return () => {
              interrupt = undefined;
            };
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    const events = CliEventV2StreamSchema.parse(io.stdout.map((value) => JSON.parse(value)));
    expect(events.map((event) => event.type)).toEqual([
      "run.progress",
      "mission.snapshot",
      "watch.ready",
      "watch.detached",
      "stream.end",
    ]);
    expect(events[0]).toMatchObject({
      eventId: EVENT_ID,
      cursor: CURSOR,
      replayable: true,
      emittedAt: "2026-08-27T00:00:01.000Z",
    });
    expect(events[1]).toMatchObject({
      type: "mission.snapshot",
      replayable: false,
      data: { cursor: CURSOR },
    });
    expect(events[1]).not.toHaveProperty("cursor");
    expect(events[2]).toMatchObject({
      type: "watch.ready",
      replayable: false,
      data: { cursor: CURSOR },
    });
    expect(events[2]).not.toHaveProperty("cursor");
    expect(events[3]).toMatchObject({
      data: { missionContinues: true, lastCursor: CURSOR },
      replayable: false,
    });
    expect(events[4]).toMatchObject({
      data: { status: "succeeded", exitCode: 0, lastCursor: CURSOR },
    });
    expect(watchMission).toHaveBeenCalledOnce();
    expect(io.stderr).toEqual([]);
  });

  it("renders text detach and never requires a mutation/lease port", async () => {
    const io = createIo();
    const watchMission = async (input: MissionWatchRequest): Promise<MissionWatchResult> => {
      await input.onEvent({
        type: "watch.ready",
        data: { missionId: MISSION_ID, cursor: CURSOR },
        missionId: MISSION_ID,
        replayable: false,
        cursor: CURSOR,
      });
      return {
        missionId: MISSION_ID,
        status: "detached",
        missionContinues: true,
        lastCursor: CURSOR,
      };
    };

    await expect(
      runCli(["mission", "watch", MISSION_ID], io, {
        localHost: { watchMission } as unknown as CliLocalHost,
      }),
    ).resolves.toBe(0);
    expect(io.stdout.join("")).toContain("Watching Mission");
    expect(io.stdout.join("")).toContain("Detached; Mission continues.");
    expect(io.stderr).toEqual([]);
  });

  it("returns INVALID_FORMAT with exit 2 for --format json", async () => {
    const io = createIo();
    await expect(runCli(["--format=json", "mission", "watch", MISSION_ID], io)).resolves.toBe(2);
    expect(JSON.parse(io.stdout[0]!)).toMatchObject({
      status: "failed",
      error: { code: "INVALID_FORMAT" },
    });
  });
});

function createIo(): CliIo & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}
