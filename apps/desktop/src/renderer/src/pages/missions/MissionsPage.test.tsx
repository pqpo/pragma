import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  Mission,
  MissionChatSnapshot,
  MissionSummary,
  MissionWorkRecord,
} from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import {
  applyMissionChatPatches,
  claimMissionClientOperation,
  CONTEXT_POPOVER_CLOSE_DELAY_MS,
  ContextWindowControl,
  groupMissionConversationEntries,
  MissionContextOperationEntry,
  MissionDetailFragment,
  MissionThinkingEntry,
  MissionWorkDrawer,
  MissionsPage,
  missionWorkInputSenderName,
  missionWorkRecordTitle,
  resolveMissionRailGroups,
  resolveMissionSearchCollapsed,
  releaseMissionClientOperation,
  shouldClearMissionThinkingPlaceholder,
  shouldShowMissionThinkingPlaceholder,
  unavailableMcpToolName,
  upsertMissionSummary,
} from "./MissionsPage.tsx";

describe("MissionsPage", () => {
  it("keeps creation outside the missions surface", () => {
    const html = renderToStaticMarkup(<MissionsPage onCreate={() => undefined} />);

    expect(html).toContain("New mission");
    expect(html).not.toContain("mission-create-selectors");
    expect(html).not.toContain("Needs input");
    expect(html).not.toContain("No missions need input");
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

  it("ignores scroll corrections caused by the search transition at the list boundary", () => {
    expect(
      resolveMissionSearchCollapsed({
        collapsed: true,
        previousScrollTop: 640,
        scrollTop: 578,
        transitionLocked: true,
      }),
    ).toBe(true);
  });

  it("puts Missions that need input in their own pinned top group", () => {
    const groups = resolveMissionRailGroups({
      missions: [
        missionSummaryFixture({
          id: "active-running",
          title: "Running Mission",
          status: "running",
          updatedAt: "2026-07-11T00:00:03.000Z",
        }),
        missionSummaryFixture({
          id: "waiting-newer",
          title: "Waiting Mission",
          status: "waiting",
          updatedAt: "2026-07-11T00:00:04.000Z",
        }),
        missionSummaryFixture({
          id: "waiting-pinned",
          title: "Pinned Waiting Mission",
          status: "waiting",
          updatedAt: "2026-07-11T00:00:01.000Z",
        }),
        missionSummaryFixture({
          id: "completed",
          title: "Completed Mission",
          lifecycleStatus: "completed",
          status: "succeeded",
          updatedAt: "2026-07-11T00:00:02.000Z",
        }),
      ],
      pinnedMissionIds: ["waiting-pinned"],
      visibleLimits: { waitingInput: 10, active: 10, completed: 5 },
    });

    expect(groups.waitingInput.visibleMissions.map((mission) => mission.id)).toEqual([
      "waiting-pinned",
      "waiting-newer",
    ]);
    expect(groups.active.visibleMissions.map((mission) => mission.id)).toEqual(["active-running"]);
    expect(groups.completed.visibleMissions.map((mission) => mission.id)).toEqual(["completed"]);
  });

  it("limits mission rail groups and exposes the remaining count for loading more", () => {
    const waiting = Array.from({ length: 11 }, (_, index) =>
      missionSummaryFixture({
        id: `waiting-${index}`,
        title: `Waiting ${index}`,
        status: "waiting",
        updatedAt: `2026-07-11T00:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const active = Array.from({ length: 12 }, (_, index) =>
      missionSummaryFixture({
        id: `active-${index}`,
        title: `Active ${index}`,
        status: "running",
        updatedAt: `2026-07-11T00:01:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const completed = Array.from({ length: 16 }, (_, index) =>
      missionSummaryFixture({
        id: `completed-${index}`,
        title: `Completed ${index}`,
        lifecycleStatus: "completed",
        status: "succeeded",
        updatedAt: `2026-07-11T00:02:${String(index).padStart(2, "0")}.000Z`,
      }),
    );

    const initial = resolveMissionRailGroups({
      missions: [...waiting, ...active, ...completed],
      pinnedMissionIds: [],
      visibleLimits: { waitingInput: 10, active: 10, completed: 5 },
    });

    expect(initial.waitingInput.visibleMissions).toHaveLength(10);
    expect(initial.waitingInput.hiddenCount).toBe(1);
    expect(initial.active.visibleMissions).toHaveLength(10);
    expect(initial.active.hiddenCount).toBe(2);
    expect(initial.completed.visibleMissions).toHaveLength(5);
    expect(initial.completed.hiddenCount).toBe(11);

    const afterLoadMore = resolveMissionRailGroups({
      missions: [...waiting, ...active, ...completed],
      pinnedMissionIds: [],
      visibleLimits: { waitingInput: 20, active: 20, completed: 15 },
    });

    expect(afterLoadMore.waitingInput.visibleMissions).toHaveLength(11);
    expect(afterLoadMore.waitingInput.hiddenCount).toBe(0);
    expect(afterLoadMore.active.visibleMissions).toHaveLength(12);
    expect(afterLoadMore.active.hiddenCount).toBe(0);
    expect(afterLoadMore.completed.visibleMissions).toHaveLength(15);
    expect(afterLoadMore.completed.hiddenCount).toBe(1);
  });

  it("applies global Mission updates without allowing stale events to regress the rail", () => {
    const current = missionSummaryFixture({
      id: "mission",
      title: "Current",
      status: "succeeded",
      updatedAt: "2026-07-11T00:00:02.000Z",
    });
    const stale = missionSummaryFixture({
      id: "mission",
      title: "Stale",
      status: "running",
      updatedAt: "2026-07-11T00:00:01.000Z",
    });
    const newer = missionSummaryFixture({
      id: "mission",
      title: "Newer",
      status: "failed",
      updatedAt: "2026-07-11T00:00:03.000Z",
    });

    expect(upsertMissionSummary([current], stale)).toEqual([current]);
    expect(upsertMissionSummary([current], newer)).toEqual([newer]);
  });

  it("uses the required 500ms context popover grace period", () => {
    expect(CONTEXT_POPOVER_CLOSE_DELAY_MS).toBe(500);
  });
});

describe("MissionDetailFragment", () => {
  it("holds a synchronous client-operation lock throughout context compaction", () => {
    const compacting = claimMissionClientOperation({ kind: "idle" }, "compacting", "compact-token");

    expect(compacting).toEqual({ kind: "compacting", token: "compact-token" });
    expect(claimMissionClientOperation(compacting!, "sending", "send-token")).toBeNull();
    expect(releaseMissionClientOperation(compacting!, "stale-token")).toBe(compacting);
    expect(releaseMissionClientOperation(compacting!, "compact-token")).toEqual({ kind: "idle" });
  });

  it("renders context compaction progress, completion, and retryable failure states", () => {
    const started = renderToStaticMarkup(
      <MissionContextOperationEntry
        operation={{
          id: "compact-1",
          createdAt: "2026-07-24T00:00:00.000Z",
          status: "running",
        }}
        onRetry={() => undefined}
      />,
    );
    const completed = renderToStaticMarkup(
      <MissionContextOperationEntry
        operation={{
          id: "compact-1",
          createdAt: "2026-07-24T00:00:00.000Z",
          status: "succeeded",
        }}
        onRetry={() => undefined}
      />,
    );
    const failed = renderToStaticMarkup(
      <MissionContextOperationEntry
        operation={{
          id: "compact-1",
          createdAt: "2026-07-24T00:00:00.000Z",
          status: "failed",
          error: "The Runtime could not compact this context.",
        }}
        onRetry={() => undefined}
      />,
    );

    expect(started).toContain("Compacting context");
    expect(completed).toContain("Context compaction completed");
    expect(failed).toContain("Context compaction failed");
    expect(failed).toContain("The Runtime could not compact this context.");
    expect(failed).toContain(">Retry<");
  });

  it("renders the context ring with an accessible percentage label", () => {
    const html = renderToStaticMarkup(
      <ContextWindowControl
        state={{
          supportsInspection: true,
          supportsCompaction: true,
          canCompact: true,
          usage: {
            usedTokens: 50_000,
            contextWindowTokens: 200_000,
            percent: 25,
            measurement: "reported",
            observedAt: "2026-07-24T00:00:00.000Z",
          },
        }}
        compacting={false}
        onCompact={() => undefined}
      />,
    );

    expect(html).toContain("mission-context-trigger");
    expect(html).toContain('stroke-dashoffset="75"');
    expect(html).toContain('aria-label="Context window usage: 25%"');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("bounds impossible context usage and exposes a diagnostic warning", () => {
    const html = renderToStaticMarkup(
      <ContextWindowControl
        state={{
          supportsInspection: true,
          supportsCompaction: true,
          canCompact: true,
          usage: {
            usedTokens: 663_493,
            contextWindowTokens: 258_400,
            percent: 256.8,
            measurement: "reported",
            observedAt: "2026-07-24T00:00:00.000Z",
          },
        }}
        compacting={false}
        onCompact={() => undefined}
      />,
    );

    expect(html).toContain('stroke-dashoffset="0"');
    expect(html).toContain("mission-context-warning-badge");
    expect(html).toContain("Context window usage: 100%");
    expect(html).toContain("Runtime reported invalid context usage");
    expect(html).not.toContain("256.8%");
  });

  it("uses the full detail width for a single expert", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("expert")} />);

    expect(html).toContain(">Chat<");
    expect(html).toContain("mission-chat-scroll");
    expect(html).toContain("mission-chat-footer");
    expect(html).toContain("mission-chat-composer");
    expect(html).toContain("mission-chat-composer-toolbar");
    expect(html).toContain("This Mission has used 0 tokens");
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

  it("turns a removed MCP tool error into an actionable Expert repair prompt", () => {
    const html = renderToStaticMarkup(
      <MissionDetailFragment
        mission={missionFixture("expert")}
        error={
          'Error invoking remote method "missions:run": MCP tool search_issues is not currently available.'
        }
        onEditExpert={() => undefined}
      />,
    );

    expect(html).toContain("search_issues");
    expect(html).toContain("Edit Expert");
    expect(html).not.toContain("Error invoking remote method");
  });

  it("directs team tool failures to Studio", () => {
    const html = renderToStaticMarkup(
      <MissionDetailFragment
        mission={missionFixture("team")}
        error="MCP tool search_issues is not currently available."
        onEditExpert={() => undefined}
      />,
    );

    expect(html).toContain("Open Studio");
  });
});

describe("unavailableMcpToolName", () => {
  it("extracts the selected tool from an Electron-wrapped IPC error", () => {
    expect(
      unavailableMcpToolName(
        "Error invoking remote method 'missions:run': Error: MCP tool search_issues is not currently available.",
      ),
    ).toBe("search_issues");
  });

  it("ignores unrelated execution errors", () => {
    expect(unavailableMcpToolName("Execution failed.")).toBeUndefined();
  });
});

describe("Mission work record titles", () => {
  it("keeps real names and localizes unnamed runtime-agent ordinals", async () => {
    const record: MissionWorkRecord = {
      recordId: "runtime-agent:child",
      kind: "runtime-agent",
      sessionId: "child",
      title: "Subagent 2",
      fallbackOrdinal: 2,
      origin: "runtime",
      status: "running",
      tasks: [],
      summary: "Inspect the repository",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };

    await i18n.changeLanguage("zh-Hans");
    expect(missionWorkRecordTitle(record)).toBe("子代理 2");
    expect(
      missionWorkRecordTitle({ ...record, title: "架构专家", fallbackOrdinal: undefined }),
    ).toBe("架构专家");
    await i18n.changeLanguage("en");
    expect(missionWorkRecordTitle(record)).toBe("Subagent 2");
  });

  it("uses the parent agent name for delegated input and keeps fresh contexts distinct", async () => {
    const parent: MissionWorkRecord = {
      recordId: "runtime-agent:coordinator",
      kind: "runtime-agent",
      sessionId: "coordinator",
      title: "Coordinator",
      origin: "runtime",
      status: "running",
      tasks: [],
      summary: "Coordinate the work",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const children: MissionWorkRecord[] = ["child-a", "child-b"].map((sessionId) => ({
      recordId: `runtime-agent:${sessionId}`,
      kind: "runtime-agent",
      sessionId,
      parentRecordId: parent.recordId,
      title: "Researcher",
      origin: "runtime",
      status: "running",
      tasks: [],
      summary: "Research the task",
      createdAt: "2026-07-21T00:00:01.000Z",
      updatedAt: "2026-07-21T00:00:01.000Z",
    }));

    await i18n.changeLanguage("en");
    expect(missionWorkInputSenderName(children[0]!, [parent, ...children])).toBe("Coordinator");
    expect(
      missionWorkInputSenderName(
        { ...parent, recordId: "root", kind: "root", parentRecordId: undefined },
        [parent, ...children],
      ),
    ).toBe("You");
    expect(new Set(children.map((record) => record.recordId))).toHaveProperty("size", 2);
    expect(
      missionWorkInputSenderName({ ...children[0]!, parentRecordId: "missing" }, children),
    ).toBe("Main agent");
  });
});

describe("Mission work conversation", () => {
  it("renders a read-only chat with the parent sender and no task/output split", () => {
    const record: MissionWorkRecord = {
      recordId: "runtime-agent:researcher",
      kind: "runtime-agent",
      sessionId: "researcher",
      parentRecordId: "runtime-agent:coordinator",
      title: "Researcher",
      origin: "runtime",
      status: "running",
      tasks: [],
      summary: "Inspect the repository",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      <MissionWorkDrawer
        record={record}
        inputSenderName="Coordinator"
        entries={[
          {
            id: "input-1",
            kind: "user",
            content: "Inspect the repository",
            createdAt: "2026-07-21T00:00:00.000Z",
          },
          {
            id: "answer-1",
            kind: "assistant",
            content: "The architecture is sound.",
            streaming: true,
            createdAt: "2026-07-21T00:00:01.000Z",
          },
        ]}
        loading={false}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("Agent conversation");
    expect(html).toContain("Read-only conversation");
    expect(html).toContain("mission-message-sender");
    expect(html).toContain("Coordinator");
    expect(html).toContain("Inspect the repository");
    expect(html).toContain("The architecture is sound.");
    expect(html).not.toContain("Session tasks");
    expect(html).not.toContain("Live output");
    expect(html).not.toContain("mission-work-tasks");
    expect(html).not.toContain("mission-chat-composer");
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
    schemaVersion: "pragma.mission/v5",
    id: "00000000-0000-4000-8000-000000000000",
    title: "Missions page design",
    goal: "Design the Missions page.",
    initialMessageId: "00000000-0000-4000-8000-000000000001",
    toolPermissionMode: "request-approval",
    workspace: { path: "/workspace/expert-mesh", basename: "expert-mesh" },
    project: { id: "studio", revision: 1 },
    executor: {
      kind,
      ref: kind === "expert" ? "expert:v2vt1v01vzz6j24q" : "team:gmpsevbrb8danedb",
      name: kind === "expert" ? "Product Designer" : "Delivery Team",
    },
    lifecycleStatus: "active",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function missionSummaryFixture(input: {
  readonly id: string;
  readonly title: string;
  readonly lifecycleStatus?: MissionSummary["lifecycleStatus"] | undefined;
  readonly status?: NonNullable<MissionSummary["execution"]>["status"] | undefined;
  readonly updatedAt: string;
}): MissionSummary {
  return {
    id: input.id,
    title: input.title,
    workspace: { basename: "expert-mesh" },
    executor: { kind: "expert", name: "Product Designer" },
    ...(input.status === undefined ? {} : { execution: { status: input.status } }),
    lifecycleStatus: input.lifecycleStatus ?? "active",
    updatedAt: input.updatedAt,
  };
}
