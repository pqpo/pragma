import type { DurableExecutionStore, ExecutionWorkRecord } from "@pragma/core";
import type { MissionStore } from "../../src/missions/repository/mission-store.ts";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GetMissionChatPageSchema } from "@pragma/shared";
import {
  readMissionChatHistoryPage,
  decodeMissionChatPageCursor,
  encodeMissionChatPageCursor,
  orderMissionExecutionEntries,
  ensureTerminalExecutionResultEntry,
  workTaskInputEntries,
} from "../../src/missions/mission-chat-history.ts";

describe("Mission chat history", () => {
  it("projects structured work prompts as text and attachments while preserving other inputs", () => {
    const timestamp = "2026-10-08T00:00:00.000Z";
    const attachments = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "image",
        name: "screen.png",
        path: "/screen.png",
        mimeType: "image/png",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        kind: "file",
        name: "notes.txt",
        path: "/notes.txt",
      },
      { id: "00000000-0000-4000-8000-000000000003", kind: "directory", name: "src", path: "/src" },
    ];
    const inputs = [
      { text: "只回复ok", attachments: [] },
      { text: "Inspect attachments", attachments },
      "Plain prompt",
      { prompt: "Delegated prompt" },
      { query: "Flow input" },
    ];
    const record: ExecutionWorkRecord = {
      recordId: "root",
      kind: "root",
      sessionId: "session",
      origin: "core",
      status: "succeeded",
      createdAt: timestamp,
      updatedAt: timestamp,
      tasks: inputs.map((input, index) => ({
        taskId: String(index),
        executionId: "execution",
        invocationId: String(index),
        runId: "run",
        status: "succeeded",
        input,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    };
    const entries = workTaskInputEntries(record);
    expect(entries.map((entry) => entry.content)).toEqual([
      "只回复ok",
      "Inspect attachments",
      "Plain prompt",
      "Delegated prompt",
      JSON.stringify({ query: "Flow input" }, null, 2),
    ]);
    expect(entries[0]).toMatchObject({ kind: "user", attachments: [] });
    expect(entries[1]).toMatchObject({ kind: "user", attachments });
  });
  it.each(["pending", "unavailable"] as const)(
    "shows a durable projection while source verification is %s",
    async (state) => {
      const timestamp = "2026-10-02T00:00:00.000Z";
      const projected = {
        id: "answer",
        executionId: "execution",
        invocationId: "root",
        kind: "assistant" as const,
        content: "Saved answer",
        streaming: false,
        createdAt: timestamp,
      };
      const get = vi.fn(async () => {
        throw new Error("The core read must not run during preparation");
      });
      const prepare = vi.fn();
      const store = {
        get,
        getPrepared: vi.fn(async () => {
          if (state === "unavailable") throw new Error("Unsupported source version");
          return { state: "requires_preparation" as const };
        }),
      } as unknown as DurableExecutionStore;
      const missions = {
        readTimelinePage: async () => ({
          turns: [
            {
              sequence: 1,
              message: { id: "user", content: "Question", createdAt: timestamp },
              executionId: "execution",
            },
          ],
        }),
        readExecutionProjectionPage: async () => ({
          entries: [projected],
          omittedEntries: 0,
          truncatedFields: 0,
        }),
      } as unknown as MissionStore;
      const result = await readMissionChatHistoryPage({
        missionId: "mission",
        query: { id: "mission", limit: 50 },
        executionStore: store,
        missions,
        rootOnly: false,
        onPreparationRequired: prepare,
      });
      expect(result.sourceVerification).toBe(state);
      expect(result.entries.map((entry) => entry.id)).toEqual(["user", "answer"]);
      expect(get).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
      const privateResult = await readMissionChatHistoryPage({
        missionId: "mission",
        query: { id: "mission", limit: 50 },
        executionStore: store,
        missions,
        rootOnly: true,
        onPreparationRequired: prepare,
      });
      expect(privateResult.entries.map((entry) => entry.id)).toEqual(["user"]);
    },
  );
  it("repairs a surviving rejected attempt instead of trusting its finalAnswer flag", () => {
    const entries = ensureTerminalExecutionResultEntry(
      [
        {
          id: "attempt-1",
          executionId: "execution",
          invocationId: "root",
          kind: "assistant",
          content: "invalid JSON",
          finalAnswer: true,
          streaming: false,
          createdAt: "2026-09-29T00:00:00.000Z",
        },
      ],
      {
        executionId: "execution",
        rootInvocationId: "root",
        status: "succeeded",
        output: { type: "inline", value: { answer: "done" } },
        updatedAt: "2026-09-29T00:00:01.000Z",
      },
    );
    expect(entries.at(-1)).toMatchObject({
      id: "result:execution",
      kind: "assistant",
      finalAnswer: true,
      content: "done",
    });
    expect(entries[0]).toMatchObject({ id: "attempt-1", finalAnswer: false });
  });
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
