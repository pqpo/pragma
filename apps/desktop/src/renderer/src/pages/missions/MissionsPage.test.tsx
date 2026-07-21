import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  Mission,
  MissionChatSnapshot,
  MissionWorkItem,
} from "../../../../shared/desktop-api.ts";
import {
  agentLifecycleAction,
  applyMissionChatPatches,
  groupMissionConversationEntries,
  groupMissionWorkItems,
  MissionDetailFragment,
  MissionsPage,
  shouldClearMissionThinkingPlaceholder,
} from "./MissionsPage.tsx";

describe("MissionsPage", () => {
  it("keeps creation outside the missions surface", () => {
    const html = renderToStaticMarkup(<MissionsPage onCreate={() => undefined} />);

    expect(html).toContain("New mission");
    expect(html).not.toContain("mission-create-selectors");
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

  it("keeps agent lifecycle interactions visible instead of folding them into tool groups", () => {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const blocks = groupMissionConversationEntries(
      ["Read", "mcp__pragma__spawn_expert", "wait_agents", "Write"].map((toolName, index) => ({
        type: "durable" as const,
        entry: {
          id: `tool-${index}`,
          kind: "tool" as const,
          toolCallId: `call-${index}`,
          toolName,
          status: "succeeded" as const,
          createdAt,
        },
      })),
    );

    expect(blocks).toHaveLength(4);
    expect(blocks[1]).toMatchObject({ type: "tools", entries: [{ toolName: expect.any(String) }] });
    expect(blocks[2]).toMatchObject({ type: "tools", entries: [{ toolName: "wait_agents" }] });
    expect(agentLifecycleAction("mcp__pragma__spawn_expert")).toBe("spawn");
    expect(agentLifecycleAction("list_experts")).toBe("list");
    expect(agentLifecycleAction("send_message")).toBe("message");
    expect(agentLifecycleAction("read_file")).toBeUndefined();
  });
});

describe("Mission work records", () => {
  it("groups follow-up invocations in one runtime Context session", () => {
    const item = (
      invocationId: string,
      contextId: string,
      taskSequence: number,
      status: MissionWorkItem["status"],
    ): MissionWorkItem => ({
      invocationId,
      parentInvocationId: "root",
      executorId: "researcher",
      executorName: "Researcher",
      agentId: `agent-${contextId}`,
      contextId,
      taskSequence,
      kind: "expert",
      status,
      inputSummary: `task ${taskSequence}`,
      createdAt: `2026-07-21T00:00:0${taskSequence}.000Z`,
      updatedAt: `2026-07-21T00:00:0${taskSequence}.000Z`,
    });
    const records = groupMissionWorkItems([
      item("child-1", "context-a", 0, "succeeded"),
      item("child-2", "context-a", 1, "running"),
      item("child-3", "context-b", 0, "succeeded"),
    ]);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      key: "context:context-a",
      title: "Researcher",
      status: "running",
      invocationIds: ["child-1", "child-2"],
      items: [{ taskSequence: 0 }, { taskSequence: 1 }],
    });
    expect(records[1]).toMatchObject({
      key: "context:context-b",
      invocationIds: ["child-3"],
    });
  });
});

describe("Mission thinking placeholder", () => {
  const requestId = "00000000-0000-4000-8000-000000000020";
  const previousExecutionId = "00000000-0000-4000-8000-000000000021";
  const currentExecutionId = "00000000-0000-4000-8000-000000000022";

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
