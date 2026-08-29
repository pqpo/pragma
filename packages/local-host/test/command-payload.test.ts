import { describe, expect, it } from "vitest";

import { canonicalMissionCommandPayloadJson, hashMissionCommandPayload } from "../src/index.ts";

const missionId = "00000000-0000-4000-8000-000000000201";

describe("canonical Mission command payload", () => {
  it("normalizes prompts and recursively sorts semantic object keys", () => {
    const first = {
      missionId,
      kind: "send" as const,
      payload: { kind: "send" as const, input: { prompt: "  hello\r\nworld  " } },
    };
    const second = {
      missionId,
      kind: "send" as const,
      payload: { kind: "send" as const, input: { prompt: "hello\nworld" } },
    };

    expect(hashMissionCommandPayload(first)).toBe(hashMissionCommandPayload(second));
    expect(canonicalMissionCommandPayloadJson(first)).toContain('"missionId"');
  });

  it("includes semantic targets and preserves array order", () => {
    const base = {
      missionId,
      kind: "steer" as const,
      target: {
        executionId: "00000000-0000-4000-8000-000000000202",
        turnId: "turn-1",
      },
      payload: { kind: "steer" as const, input: { prompt: "continue" } },
    };
    const changedTarget = {
      ...base,
      target: { ...base.target, turnId: "turn-2" },
    };

    expect(hashMissionCommandPayload(base)).not.toBe(hashMissionCommandPayload(changedTarget));
  });

  it("excludes the owner fencing token from the semantic hash", () => {
    const base = {
      missionId,
      kind: "steer" as const,
      target: {
        executionId: "00000000-0000-4000-8000-000000000202",
        turnId: "turn-1",
      },
      targetFencingToken: "1",
      payload: { kind: "steer" as const, input: { prompt: "continue" } },
    };
    const renewed = {
      ...base,
      targetFencingToken: "2",
    };

    expect(hashMissionCommandPayload(base)).toBe(hashMissionCommandPayload(renewed));
  });

  it("hashes human responses while leaving request metadata outside the contract", () => {
    const response = {
      missionId,
      kind: "respond" as const,
      target: { interactionId: "interaction-1" },
      payload: {
        kind: "respond" as const,
        response: { data: { z: 1, a: ["first", "second"] }, approved: true },
      },
    };
    const reordered = {
      ...response,
      payload: {
        ...response.payload,
        response: { approved: true, data: { a: ["first", "second"], z: 1 } },
      },
    };

    expect(hashMissionCommandPayload(response)).toBe(hashMissionCommandPayload(reordered));
  });
});
