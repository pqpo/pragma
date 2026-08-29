import { describe, expect, it } from "vitest";

import {
  MissionBranchHistorySchema,
  type MissionChatEntry,
} from "../../../shared/contracts/index.ts";
import { createMissionBranchContext } from "./mission-branch-context.ts";

describe("createMissionBranchContext", () => {
  it("preloads a bounded recent conversation without deriving a Mission goal", () => {
    const entries: MissionChatEntry[] = [
      {
        id: "old-user",
        kind: "user",
        content: `obsolete-first-message-${"x".repeat(5_000)}`,
        timelineSequence: 1,
        createdAt: "2026-08-25T00:00:00.000Z",
      },
      {
        id: "old-assistant",
        kind: "assistant",
        content: "Obsolete response",
        streaming: false,
        timelineSequence: 1,
        createdAt: "2026-08-25T00:01:00.000Z",
      },
      {
        id: "current-user",
        kind: "user",
        content: "Use the current mobile dashboard direction.",
        timelineSequence: 2,
        createdAt: "2026-08-25T00:02:00.000Z",
      },
      {
        id: "current-assistant",
        kind: "assistant",
        content: "The mobile dashboard direction is ready.",
        streaming: false,
        timelineSequence: 2,
        createdAt: "2026-08-25T00:03:00.000Z",
      },
    ];
    const context = createMissionBranchContext(
      MissionBranchHistorySchema.parse({
        schemaVersion: "pragma.mission-branch-history/v1",
        source: {
          sourceMissionId: "00000000-0000-4000-8000-000000000001",
          sourceProjectRevision: 1,
          cutoffMessageId: "current-assistant",
          createdAt: "2026-08-25T00:04:00.000Z",
        },
        entries,
      }),
    );

    const branch = context.find((item) => item.id === "BRANCH.md");
    const recent = context.find((item) => item.id === "RECENT.md");
    const transcript = context.find((item) => item.id === "transcript.md");

    expect(branch?.content).not.toContain("Mission goal");
    expect(branch?.content).toContain('namespace="branch-history" and id="transcript.md"');
    expect(recent?.metadata?.trigger).toBe("always_on");
    expect(recent?.metadata?.trustLevel).toBe("user");
    expect(recent?.content).toContain("Use the current mobile dashboard direction.");
    expect(recent?.content).toContain("The mobile dashboard direction is ready.");
    expect(recent?.content).not.toContain("obsolete-first-message");
    expect(Buffer.byteLength(recent?.content ?? "", "utf8")).toBeLessThanOrEqual(3 * 1_024);
    expect(transcript?.metadata?.trigger).toBe("manual");
    expect(transcript?.content).toContain("obsolete-first-message");
  });

  it("keeps short inherited messages as conversation rather than a derived objective", () => {
    const context = createMissionBranchContext(
      MissionBranchHistorySchema.parse({
        schemaVersion: "pragma.mission-branch-history/v1",
        source: {
          sourceMissionId: "00000000-0000-4000-8000-000000000002",
          sourceProjectRevision: 3,
          cutoffMessageId: "assistant",
          createdAt: "2026-08-25T01:00:00.000Z",
        },
        entries: [
          {
            id: "user",
            kind: "user",
            content: "This is a message, not a declared goal.",
            timelineSequence: 1,
            createdAt: "2026-08-25T00:58:00.000Z",
          },
          {
            id: "assistant",
            kind: "assistant",
            content: "Understood.",
            streaming: false,
            timelineSequence: 1,
            createdAt: "2026-08-25T00:59:00.000Z",
          },
        ],
      }),
    );

    expect(context.find((item) => item.id === "RECENT.md")?.content).toContain(
      "#### User\n\nThis is a message, not a declared goal.",
    );
  });
});
