import { expect, it } from "vitest";
import {
  CliCompactEndSchema,
  CliCompactEventSchema,
  CliCompactResultSchema,
} from "../src/integration/index.ts";

const id = "11111111-1111-4111-8111-111111111111";
it("rejects success without a result and mismatched stream outcomes", () => {
  expect(
    CliCompactResultSchema.safeParse({
      schemaVersion: "pragma.cli-result/v3",
      requestId: id,
      command: "mission.get",
      status: "succeeded",
    }).success,
  ).toBe(false);
  expect(CliCompactEndSchema.safeParse({ status: "succeeded", exitCode: 4 }).success).toBe(false);
  expect(
    CliCompactEndSchema.safeParse({ status: "succeeded", exitCode: 0, observedStatus: "failed" })
      .success,
  ).toBe(false);
  expect(
    CliCompactEventSchema.safeParse({
      schemaVersion: "pragma.cli-event/v3",
      requestId: id,
      sequence: 1,
      type: "stream.end",
      data: { status: "succeeded", exitCode: 0, result: "duplicate" },
    }).success,
  ).toBe(false);
});
it("requires real replay identity while allowing synthetic compact end events", () => {
  const event = {
    schemaVersion: "pragma.cli-event/v3",
    requestId: id,
    sequence: 0,
    type: "run.progress",
    data: {},
    replayable: true,
    cursor: "opaque",
  };
  expect(CliCompactEventSchema.safeParse(event).success).toBe(false);
  expect(
    CliCompactEventSchema.safeParse({ ...event, eventId: id, emittedAt: "2026-10-14T00:00:00Z" })
      .success,
  ).toBe(true);
  expect(
    CliCompactEventSchema.safeParse({
      schemaVersion: "pragma.cli-event/v3",
      requestId: id,
      sequence: 1,
      type: "stream.end",
      data: { status: "accepted", exitCode: 0, missionId: id, lastCursor: "opaque" },
    }).success,
  ).toBe(true);
});
