import { describe, expect, it } from "vitest";
import { missionContentReference, readMissionContentValue } from "../src/mission-content-query.ts";
import type { ContentSelector } from "@pragma/shared/integration";

const missionId = "11111111-1111-4111-8111-111111111111";
describe("bounded Mission content", () => {
  it("uses the validated selector defaults", () => {
    const value = "body ".repeat(2000);
    const reference = missionContentReference(missionId, "event", "event-id", value, 4)!;
    const page = readMissionContentValue(
      missionId,
      {
        source: "event",
        id: "event-id",
        fingerprint: reference.fingerprint,
      } as ContentSelector,
      value,
    );
    expect(page.contentRange).toMatchObject({ start: 0, end: 8000, nextStart: 8000 });
  });
  it("reconstructs Unicode text and binds all reads to the exact content", () => {
    const value = "中😀文\n".repeat(10);
    const reference = missionContentReference(missionId, "result", missionId, value, 4)!;
    expect(reference.preview).toBe("中");
    let rebuilt = reference.preview;
    let start = reference.end;
    while (start < reference.totalBytes) {
      const page = readMissionContentValue(
        missionId,
        { source: "result", id: missionId, fingerprint: reference.fingerprint, start, maxBytes: 4 },
        value,
      );
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(4);
      expect(page.contentRange.end).toBeGreaterThan(start);
      rebuilt += page.content;
      start = page.contentRange.end;
    }
    expect(rebuilt).toBe(value);
    expect(() =>
      readMissionContentValue(
        missionId,
        {
          source: "result",
          id: missionId,
          fingerprint: reference.fingerprint,
          start: 0,
          maxBytes: 4,
        },
        value + "changed",
      ),
    ).toThrowError(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    expect(() =>
      readMissionContentValue(
        missionId,
        {
          source: "result",
          id: missionId,
          fingerprint: reference.fingerprint,
          start: 1,
          maxBytes: 4,
        },
        value,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });
  it("preserves non-well-formed strings through explicit JSON encoding", () => {
    const value = "\ud800" + "body".repeat(10);
    const reference = missionContentReference(missionId, "result", missionId, value, 4)!;
    const page = readMissionContentValue(
      missionId,
      {
        source: "result",
        id: missionId,
        fingerprint: reference.fingerprint,
        start: 0,
        maxBytes: 64000,
      },
      value,
    );
    expect(page.encoding).toBe("utf8-json");
    expect(JSON.parse(page.content)).toBe(value);
  });

  it("uses JSON encoding for structured results and leaves small/empty data inline", () => {
    expect(missionContentReference(missionId, "result", missionId, "", 4)).toBeUndefined();
    const value = { answer: "内容".repeat(10) };
    const reference = missionContentReference(missionId, "result", missionId, value, 4)!;
    const whole = readMissionContentValue(
      missionId,
      {
        source: "result",
        id: missionId,
        fingerprint: reference.fingerprint,
        start: 0,
        maxBytes: 64000,
      },
      value,
    );
    expect(whole.encoding).toBe("utf8-json");
    expect(JSON.parse(whole.content)).toEqual(value);
    expect(whole.contentRange.nextStart).toBeUndefined();
  });
});
