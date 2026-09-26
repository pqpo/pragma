import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GetMissionChatPageSchema } from "../../../shared/contracts/index.ts";
import {
  decodeMissionChatPageCursor,
  encodeMissionChatPageCursor,
  orderMissionExecutionEntries,
} from "./mission-chat-history.ts";

describe("Mission chat history", () => {
  it("orders durable thinking and final replies by event sequence", () => {
    const entries = orderMissionExecutionEntries([
      {
        id: "answer",
        kind: "assistant",
        content: "Final",
        streaming: false,
        eventSequence: 12,
        createdAt: "2026-08-24T00:00:01.000Z",
      },
      {
        id: "thought",
        kind: "thinking",
        content: "Reasoning",
        streaming: false,
        eventSequence: 11,
        createdAt: "2026-08-24T00:00:02.000Z",
      },
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["thought", "answer"]);
  });

  it("keeps Mission chat entry cursors bounded and accepts long legacy cursors", () => {
    const entryId = `tool:execution:${"x".repeat(3_000)}`;
    const legacyCursor = encodeMissionChatPageCursor({
      version: 1,
      kind: "entries",
      sequence: 1,
      beforeEntryId: entryId,
    });
    expect(legacyCursor.length).toBeGreaterThan(2_048);
    expect(
      GetMissionChatPageSchema.safeParse({
        id: "00000000-0000-4000-8000-000000000001",
        beforeCursor: legacyCursor,
      }).success,
    ).toBe(true);
    expect(decodeMissionChatPageCursor(legacyCursor)).toEqual({
      version: 1,
      kind: "entries",
      sequence: 1,
      beforeEntryId: entryId,
    });

    const hash = createHash("sha256").update(entryId, "utf8").digest("hex");
    const nextCursor = encodeMissionChatPageCursor({
      version: 2,
      kind: "entries",
      sequence: 1,
      beforeEntryHash: hash,
    });
    expect(nextCursor.length).toBeLessThan(2_048);
    expect(decodeMissionChatPageCursor(nextCursor)).toEqual({
      version: 2,
      kind: "entries",
      sequence: 1,
      beforeEntryHash: hash,
    });
  });
});
