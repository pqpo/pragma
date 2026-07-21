import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Mission, MissionChatSnapshot } from "../../../../shared/desktop-api.ts";
import {
  applyMissionChatPatches,
  groupMissionConversationEntries,
  MissionDetailFragment,
  MissionThinkingEntry,
  MissionsPage,
  resolveMissionSearchCollapsed,
  shouldClearMissionThinkingPlaceholder,
  shouldShowMissionThinkingPlaceholder,
} from "./MissionsPage.tsx";

describe("MissionsPage", () => {
  it("keeps creation outside the missions surface", () => {
    const html = renderToStaticMarkup(<MissionsPage onCreate={() => undefined} />);

    expect(html).toContain("New mission");
    expect(html).not.toContain("mission-create-selectors");
  });

  it("shows thinking immediately while the first Mission message starts", () => {
    const mission = missionFixture("expert");
    const html = renderToStaticMarkup(
      <MissionsPage initialMission={mission} autoRunInitialMission onCreate={() => undefined} />,
    );

    expect(html).toContain("mission-thinking-placeholder");
    expect(html).toContain("Product Designer is thinking");
  });

  it("collapses search with upward-moving content and restores it in the reverse direction", () => {
    expect(
      resolveMissionSearchCollapsed({
        collapsed: false,
        previousScrollTop: 0,
        scrollTop: 24,
      }),
    ).toBe(true);
    expect(
      resolveMissionSearchCollapsed({
        collapsed: true,
        previousScrollTop: 64,
        scrollTop: 48,
      }),
    ).toBe(false);
  });

  it("keeps the search state stable for scroll jitter and always reveals it at the top", () => {
    expect(
      resolveMissionSearchCollapsed({
        collapsed: true,
        previousScrollTop: 48,
        scrollTop: 45,
      }),
    ).toBe(true);
    expect(
      resolveMissionSearchCollapsed({
        collapsed: true,
        previousScrollTop: 12,
        scrollTop: 2,
      }),
    ).toBe(false);
  });
});

describe("MissionDetailFragment", () => {
  it("uses the full detail width for a single expert", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("expert")} />);

    expect(html).toContain(">Chat<");
    expect(html).toContain("mission-chat-scroll");
    expect(html).toContain("mission-chat-footer");
    expect(html).toContain("mission-chat-composer");
    expect(html).toContain("mission-chat-composer-toolbar");
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Tool permissions"');
    expect(html).not.toContain("mission-execution-notice");
    expect(html).not.toContain("Pinned to");
  });

  it("keeps team conversations in the shared chat surface", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("team")} />);

    expect(html).toContain("Team channel");
    expect(html).toContain("mission-chat-composer");
    expect(html).not.toContain("mission-team-inspector");
  });

  it("replaces the send action with an interrupt action while an execution is active", () => {
    const mission = missionFixture("expert");
    mission.execution = {
      id: "00000000-0000-4000-8000-000000000010",
      inputMessageId: mission.initialMessageId,
      sessionId: "00000000-0000-4000-8000-000000000011",
      status: "running",
      startedAt: "2026-07-11T00:00:01.000Z",
    };
    const html = renderToStaticMarkup(<MissionDetailFragment mission={mission} />);

    expect(html).toContain('aria-label="Interrupt execution"');
    expect(html).not.toContain('aria-label="Send message"');
    expect(html).not.toContain("Execution running");
  });

  it("places dismissible errors above the composer", () => {
    const html = renderToStaticMarkup(
      <MissionDetailFragment
        mission={missionFixture("expert")}
        error="The message could not be submitted."
      />,
    );

    expect(html.indexOf("mission-page-error")).toBeLessThan(html.indexOf("mission-chat-composer"));
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("The message could not be submitted.");
  });
});

describe("Mission chat patches", () => {
  it("applies streaming deltas without replacing the accumulated entry", () => {
    const snapshot: MissionChatSnapshot = {
      missionId: "00000000-0000-4000-8000-000000000000",
      revision: 1,
      entries: [
        {
          id: "answer",
          kind: "assistant",
          content: "hel",
          streaming: true,
          createdAt: "2026-07-11T00:00:00.000Z",
        },
      ],
      page: {},
      pendingInteractions: [],
    };

    const updated = applyMissionChatPatches(
      snapshot,
      [
        { type: "entry.append", entryId: "answer", field: "content", delta: "lo" },
        { type: "entry.streaming", entryId: "answer", streaming: false },
      ],
      2,
    );

    expect(updated).toMatchObject({
      revision: 2,
      entries: [{ id: "answer", content: "hello", streaming: false }],
    });
    expect(
      applyMissionChatPatches(
        snapshot,
        [{ type: "entry.append", entryId: "missing", field: "content", delta: "x" }],
        2,
      ),
    ).toBeNull();
  });
});

describe("Mission tool call grouping", () => {
  it("collapses only consecutive tool calls between agent entries", () => {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const blocks = groupMissionConversationEntries([
      {
        type: "durable",
        entry: {
          id: "thinking",
          kind: "thinking",
          content: "Inspecting the project",
          streaming: false,
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "tool-1",
          kind: "tool",
          toolCallId: "call-1",
          toolName: "Read",
          status: "succeeded",
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "tool-2",
          kind: "tool",
          toolCallId: "call-2",
          toolName: "Search",
          status: "running",
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "answer",
          kind: "assistant",
          content: "Found it",
          streaming: false,
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "tool-3",
          kind: "tool",
          toolCallId: "call-3",
          toolName: "Edit",
          status: "succeeded",
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "tool-4",
          kind: "tool",
          toolCallId: "call-4",
          toolName: "Write",
          status: "running",
          createdAt,
        },
      },
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["entry", "tools", "entry", "tools"]);
    expect(blocks[1]).toMatchObject({
      type: "tools",
      collapsed: true,
      entries: [{ id: "tool-1" }, { id: "tool-2" }],
    });
    expect(blocks[3]).toMatchObject({
      type: "tools",
      collapsed: false,
      entries: [{ id: "tool-3" }, { id: "tool-4" }],
    });
  });

  it("keeps structured agent activity between ordinary tool groups", () => {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const blocks = groupMissionConversationEntries([
      {
        type: "durable",
        entry: {
          id: "tool-1",
          kind: "tool",
          toolCallId: "call-1",
          toolName: "read_file",
          status: "succeeded",
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "agent-1",
          kind: "agent_activity",
          commandId: "spawn-1",
          action: "spawn",
          phase: "completed",
          targetSessionIds: ["child-thread"],
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "tool-2",
          kind: "tool",
          toolCallId: "call-2",
          toolName: "write_file",
          status: "succeeded",
          createdAt,
        },
      },
    ]);

    expect(blocks.map((block) => block.type)).toEqual(["tools", "entry", "tools"]);
    expect(blocks[1]).toMatchObject({
      type: "entry",
      item: { entry: { kind: "agent_activity", action: "spawn" } },
    });
  });
});

describe("Mission thinking placeholder", () => {
  const requestId = "00000000-0000-4000-8000-000000000020";
  const previousExecutionId = "00000000-0000-4000-8000-000000000021";
  const currentExecutionId = "00000000-0000-4000-8000-000000000022";

  it("is visible before the first chat snapshot arrives", () => {
    expect(shouldShowMissionThinkingPlaceholder(null, requestId)).toBe(true);
  });

  it("stays visible while a newly persisted message still sees the previous execution", () => {
    const snapshot: MissionChatSnapshot = {
      missionId: "00000000-0000-4000-8000-000000000000",
      revision: 1,
      entries: [
        {
          id: requestId,
          kind: "user",
          content: "Continue",
          createdAt: "2026-07-21T00:00:00.000Z",
        },
      ],
      page: {},
      pendingInteractions: [],
      execution: {
        id: previousExecutionId,
        status: "succeeded",
        interruptible: false,
      },
    };

    expect(shouldClearMissionThinkingPlaceholder(snapshot, requestId)).toBe(false);
    expect(shouldShowMissionThinkingPlaceholder(snapshot, requestId)).toBe(true);
  });

  it("clears after the matching execution finishes without producing a response entry", () => {
    const snapshot: MissionChatSnapshot = {
      missionId: "00000000-0000-4000-8000-000000000000",
      revision: 2,
      entries: [
        {
          id: requestId,
          executionId: currentExecutionId,
          kind: "user",
          content: "Continue",
          createdAt: "2026-07-21T00:00:00.000Z",
        },
      ],
      page: {},
      pendingInteractions: [],
      execution: {
        id: currentExecutionId,
        status: "failed",
        interruptible: false,
      },
    };

    expect(shouldClearMissionThinkingPlaceholder(snapshot, requestId)).toBe(true);
    expect(shouldShowMissionThinkingPlaceholder(snapshot, requestId)).toBe(false);
  });
});

describe("Mission thinking entry", () => {
  const entry = {
    id: "thinking-entry",
    kind: "thinking" as const,
    content: "Inspecting the workspace before making changes.",
    createdAt: "2026-07-21T00:00:00.000Z",
  };

  it("shows streaming thinking in full without a collapse control", () => {
    const html = renderToStaticMarkup(
      <MissionThinkingEntry entry={{ ...entry, streaming: true }} />,
    );

    expect(html).toContain("mission-thinking-entry is-expanded is-streaming");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<button");
  });

  it("collapses completed thinking to a row with an expand control", () => {
    const html = renderToStaticMarkup(
      <MissionThinkingEntry entry={{ ...entry, streaming: false }} />,
    );

    expect(html).toContain('class="mission-thinking-entry"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Expand thinking"');
    expect(html).toContain(entry.content);
  });
});

function missionFixture(kind: "expert" | "team"): Mission {
  return {
    schemaVersion: "pragma.mission/v3",
    id: "00000000-0000-4000-8000-000000000000",
    title: "Missions page design",
    goal: "Design the Missions page.",
    initialMessageId: "00000000-0000-4000-8000-000000000001",
    toolPermissionMode: "request-approval",
    workspace: { path: "/workspace/expert-mesh", basename: "expert-mesh" },
    project: { id: "studio", revision: 1 },
    executor: {
      kind,
      ref: kind === "expert" ? "expert:product_designer@0.1.0" : "team:delivery_team@0.1.0",
      name: kind === "expert" ? "Product Designer" : "Delivery Team",
      version: "0.1.0",
    },
    lifecycleStatus: "active",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}
