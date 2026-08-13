import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  Mission,
  MissionChatSnapshot,
  MissionSummary,
  MissionWorkRecord,
} from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import { expertAvatarSource } from "../../components/ExpertAvatar.tsx";
import {
  applyMissionUsageHintRevision,
  applyMissionChatPatches,
  claimMissionClientOperation,
  CONTEXT_POPOVER_CLOSE_DELAY_MS,
  ContextWindowControl,
  DEFAULT_MISSION_MEMORY_VIEW,
  groupMissionConversationEntries,
  hasValidMissionHumanAnswers,
  mergeMissionHumanAnswers,
  mergeLatestChatPage,
  MissionContextOperationEntry,
  MissionChatEntryView,
  startMissionContextOperation,
  MissionDetailFragment,
  MissionMemoryActivity,
  MissionThinkingEntry,
  MissionToolCallBlock,
  MissionWorkGrid,
  MissionWorkDrawer,
  MissionsPage,
  MissionsPageSkeleton,
  missionWorkInputSenderName,
  missionWorkCallOrder,
  missionWorkGridEdgePath,
  missionWorkRecordTitle,
  resolveMissionsPageInitialState,
  resolveMissionRailGroups,
  resolveMissionSearchCollapsed,
  releaseMissionClientOperation,
  shouldClearMissionThinkingPlaceholder,
  shouldShowMissionThinkingPlaceholder,
  unavailableMcpToolName,
  upsertMissionSummary,
  type MissionHumanQuestion,
} from "./MissionsPage.tsx";

describe("MissionsPage", () => {
  it("shows a shimmer skeleton only when no in-memory snapshot is available", () => {
    const firstLoad = renderToStaticMarkup(<MissionsPage onCreate={() => undefined} />);
    const revisit = renderToStaticMarkup(
      <MissionsPage
        initialMemoryState={{ missions: [], selectedMission: null, selectedMissionId: null }}
        onCreate={() => undefined}
      />,
    );

    expect(firstLoad).toContain("mission-page-skeleton");
    expect(firstLoad).toContain('role="status"');
    expect(firstLoad).not.toContain("Mission not found");
    expect(revisit).not.toContain("mission-page-skeleton");
    expect(revisit).toContain("Mission not found");
  });

  it("restores the cached Mission and lets a newly created Mission take precedence", () => {
    const cached = missionFixture("expert");
    const created = { ...missionFixture("team"), id: "created-mission", title: "Created Mission" };
    const memoryState = {
      missions: [
        missionSummaryFixture({
          id: cached.id,
          title: cached.title,
          updatedAt: cached.updatedAt,
        }),
      ],
      selectedMission: cached,
      selectedMissionId: cached.id,
    };

    expect(resolveMissionsPageInitialState({ memoryState })).toMatchObject({
      selectedMission: cached,
      selectedMissionId: cached.id,
      hasResolvedInitialLoad: true,
    });
    expect(resolveMissionsPageInitialState({ memoryState, initialMission: created })).toMatchObject(
      {
        selectedMission: created,
        selectedMissionId: "created-mission",
        hasResolvedInitialLoad: true,
      },
    );
  });

  it("renders an accessible loading surface without visible placeholder copy", () => {
    const html = renderToStaticMarkup(
      <MissionsPageSkeleton label="Loading missions" railWidth={300} />,
    );

    expect(html).toContain('aria-label="Loading missions"');
    expect(html).toContain("mission-skeleton-composer");
    expect(html).not.toContain(">Loading missions<");
  });

  it("does not let a stale initial usage query overwrite a newer streaming update", () => {
    const live = applyMissionUsageHintRevision(
      { revision: -1, totalTokens: 0 },
      { revision: 8, totalTokens: 120 },
    );

    expect(applyMissionUsageHintRevision(live, { revision: 7, totalTokens: 80 })).toEqual({
      revision: 8,
      totalTokens: 120,
    });
    expect(applyMissionUsageHintRevision(live, { revision: 9, totalTokens: 155 })).toEqual({
      revision: 9,
      totalTokens: 155,
    });
  });

  it("keeps creation outside the missions surface", () => {
    const html = renderToStaticMarkup(
      <MissionsPage
        initialMemoryState={{ missions: [], selectedMission: null, selectedMissionId: null }}
        onCreate={() => undefined}
      />,
    );

    expect(html).toContain("New mission");
    expect(html).toContain('aria-label="Mission sources"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Tasks<\/button>/);
    expect(html).toMatch(/aria-selected="false"[^>]*>Automation<\/button>/);
    expect(html).toContain('aria-label="Resize navigation"');
    expect(html).not.toContain("mission-create-selectors");
    expect(html).not.toContain("Needs input");
    expect(html).not.toContain("No missions need input");
  });

  it("shows only the selected Mission source in the rail", () => {
    const task = missionSummaryFixture({
      id: "task-mission",
      title: "Manual review",
      updatedAt: "2026-07-11T00:00:02.000Z",
    });
    const automation = missionSummaryFixture({
      id: "automation-mission",
      title: "Scheduled review",
      source: {
        type: "automation",
        automationRef: "automation:m9a8n9nxvvyb4j01",
      },
      updatedAt: "2026-07-11T00:00:01.000Z",
    });
    const taskHtml = renderToStaticMarkup(
      <MissionsPage
        initialMemoryState={{
          missions: [task, automation],
          selectedMission: null,
          selectedMissionId: null,
          activeSource: "task",
        }}
        onCreate={() => undefined}
      />,
    );
    const automationHtml = renderToStaticMarkup(
      <MissionsPage
        initialMemoryState={{
          missions: [task, automation],
          selectedMission: null,
          selectedMissionId: null,
          activeSource: "automation",
        }}
        onCreate={() => undefined}
      />,
    );

    expect(taskHtml).toContain("Manual review");
    expect(taskHtml).not.toContain("Scheduled review");
    expect(automationHtml).toContain("Scheduled review");
    expect(automationHtml).not.toContain("Manual review");
    expect(automationHtml).toContain("mission-source-tabs is-automation");
  });

  it("offers the shared attachment picker in the Mission chat composer", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("expert")} />);

    expect(html).toContain('aria-label="Add context"');
    expect(html).toContain("mission-attachment-picker is-compact");
    expect(html.indexOf("mission-attachment-list is-empty")).toBeLessThan(
      html.indexOf("<textarea"),
    );
  });

  it("renders a compact, single-confirmation question flow", () => {
    const mission = missionFixture("expert");
    const chat: MissionChatSnapshot = {
      missionId: mission.id,
      revision: 1,
      entries: [],
      page: {},
      pendingInteractions: [
        {
          interactionId: "question-flow",
          request: {
            kind: "question",
            questions: [
              {
                header: "Direction",
                question: "Which direction should we take?",
                kind: "single_choice",
                options: [
                  { label: "Option one", description: "The first route." },
                  { label: "Option two", description: "The second route." },
                ],
              },
              {
                header: "Audience",
                question: "Who is this for?",
                kind: "multiple_choice",
                options: [{ label: "Designers", description: "Design teams." }],
              },
            ],
          },
        },
      ],
    };
    const html = renderToStaticMarkup(
      <MissionDetailFragment mission={mission} chatCache={new Map([[mission.id, chat]])} />,
    );
    const composerStart = html.indexOf('<section class="mission-human-composer"');
    const composerEnd = html.indexOf("</section>", composerStart);
    const composer = html.slice(composerStart, composerEnd);

    expect(html).toContain('aria-label="Previous question"');
    expect(html).toContain('aria-label="Next question"');
    expect(html).toContain('aria-live="polite">1 / 2</span>');
    expect(html).toContain("Other answer");
    expect(html).toContain('placeholder="Tell the agent what you want instead"');
    expect(composer).toContain("Confirm");
    expect(composer).toMatch(/class="primary-button"[^>]*disabled=""/);
    expect(composer.match(/class="primary-button"/g)).toHaveLength(1);
    expect(composer).not.toContain(">Back<");
    expect(composer).not.toContain(">Next<");
    expect(composer.indexOf("Option one")).toBeLessThan(composer.indexOf("Option two"));
  });

  it("localizes question controls in every supported language", async () => {
    const expected = {
      en: {
        previous: "Previous question",
        next: "Next question",
        other: "Other answer",
        confirm: "Confirm",
      },
      "zh-Hans": {
        previous: "上一题",
        next: "下一题",
        other: "其他回答",
        confirm: "确认",
      },
      "zh-Hant": {
        previous: "上一題",
        next: "下一題",
        other: "其他回答",
        confirm: "確認",
      },
    };

    for (const [locale, labels] of Object.entries(expected)) {
      await i18n.changeLanguage(locale);
      expect(i18n.t("previousQuestion", { ns: "missions" })).toBe(labels.previous);
      expect(i18n.t("nextQuestion", { ns: "missions" })).toBe(labels.next);
      expect(i18n.t("questionProgress", { ns: "missions", current: 2, total: 3 })).toBe("2 / 3");
      expect(i18n.t("customAnswer", { ns: "missions" })).toBe(labels.other);
      expect(i18n.t("confirmContinue", { ns: "missions" })).toBe(labels.confirm);
    }

    await i18n.changeLanguage("en");
  });

  it("shows thinking immediately while the first Mission message starts", () => {
    const mission = missionFixture("expert");
    const html = renderToStaticMarkup(
      <MissionsPage initialMission={mission} autoRunInitialMission onCreate={() => undefined} />,
    );

    expect(html).toContain("mission-thinking-placeholder");
    expect(html).toContain("Product Designer is thinking");
    expect(html).toContain("Preparing");
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
      visibleLimits: { waitingInput: 10, active: 10, completed: 10 },
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
      visibleLimits: { waitingInput: 10, active: 10, completed: 10 },
    });

    expect(initial.waitingInput.visibleMissions).toHaveLength(10);
    expect(initial.waitingInput.hiddenCount).toBe(1);
    expect(initial.active.visibleMissions).toHaveLength(10);
    expect(initial.active.hiddenCount).toBe(2);
    expect(initial.completed.visibleMissions).toHaveLength(10);
    expect(initial.completed.hiddenCount).toBe(6);

    const afterLoadMore = resolveMissionRailGroups({
      missions: [...waiting, ...active, ...completed],
      pinnedMissionIds: [],
      visibleLimits: { waitingInput: 20, active: 20, completed: 20 },
    });

    expect(afterLoadMore.waitingInput.visibleMissions).toHaveLength(11);
    expect(afterLoadMore.waitingInput.hiddenCount).toBe(0);
    expect(afterLoadMore.active.visibleMissions).toHaveLength(12);
    expect(afterLoadMore.active.hiddenCount).toBe(0);
    expect(afterLoadMore.completed.visibleMissions).toHaveLength(16);
    expect(afterLoadMore.completed.hiddenCount).toBe(0);
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
  it("opens memory on activity and groups capture separately from recall", () => {
    expect(DEFAULT_MISSION_MEMORY_VIEW).toBe("activity");

    const html = renderToStaticMarkup(
      <MissionMemoryActivity
        loading={false}
        onBrowseStore={() => undefined}
        activity={{
          missionId: "00000000-0000-4000-8000-000000000001",
          executions: [
            {
              executionId: "execution-1",
              capture: { published: 3, skipped: 1, failed: 0 },
              recall: { list: 1, search: 2, read: 4, denied: 0, failed: 0 },
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Browse memory store");
    expect(html).toContain("Evidence capture");
    expect(html).toContain("ContextStore recall");
    expect(html).toContain("Evidence entering memory processing, not memories created");
    expect(html).not.toContain("mission-memory-views");
  });

  it("keeps the Store reachable when memory activity is unavailable", () => {
    const html = renderToStaticMarkup(
      <MissionMemoryActivity
        loading={false}
        error="activity unavailable"
        onBrowseStore={() => undefined}
      />,
    );

    expect(html).toContain("Browse memory store");
    expect(html).toContain("Memory activity is unavailable");
    expect(html).toContain('role="alert"');
  });

  it("reuses the failed context operation when retrying", () => {
    const failed = [
      {
        id: "compact-1",
        createdAt: "2026-07-29T00:00:00.000Z",
        status: "failed" as const,
        error: "provider unavailable",
      },
    ];

    expect(
      startMissionContextOperation(failed, {
        id: "compact-1",
        createdAt: "2026-07-29T00:01:00.000Z",
        retry: true,
      }),
    ).toEqual([
      {
        id: "compact-1",
        createdAt: "2026-07-29T00:00:00.000Z",
        status: "running",
        error: undefined,
      },
    ]);
  });

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
    const skipped = renderToStaticMarkup(
      <MissionContextOperationEntry
        operation={{
          id: "compact-1",
          createdAt: "2026-07-24T00:00:00.000Z",
          status: "skipped",
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
    expect(skipped).toContain("No context compaction needed");
    expect(failed).toContain("Context compaction failed");
    expect(failed).toContain("The Runtime could not compact this context.");
    expect(failed).toContain(">Retry<");

    const automatic = renderToStaticMarkup(
      <MissionContextOperationEntry
        operation={{
          id: "context:execution-1:compact-2",
          executionId: "execution-1",
          kind: "context_operation",
          operationId: "compact-2",
          operation: "compaction",
          trigger: "auto",
          runtimeId: "cloud-pi-agent",
          status: "running",
          createdAt: "2026-07-24T00:00:01.000Z",
        }}
      />,
    );
    expect(automatic).toContain("Compacting context");
    expect(automatic).not.toContain(">Retry<");
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

  it("explains when the Runtime does not have compactable history yet", () => {
    const html = renderToStaticMarkup(
      <ContextWindowControl
        state={{
          supportsInspection: true,
          supportsCompaction: true,
          canCompact: false,
          compactionBlockedReason: "not_ready",
          usage: {
            usedTokens: 3_975,
            contextWindowTokens: 128_000,
            percent: 3.1,
            measurement: "reported",
            observedAt: "2026-07-29T00:00:00.000Z",
          },
        }}
        compacting={false}
        onCompact={() => undefined}
      />,
    );

    expect(html).toContain("There is not enough older context to compact yet.");
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
    expect(html).toContain(">Work<");
    expect(html).toContain(">Board<");
    expect(html).toContain(">Memory<");
    expect(html.indexOf(">Work<")).toBeLessThan(html.indexOf(">Board<"));
    expect(html.indexOf(">Board<")).toBeLessThan(html.indexOf(">Memory<"));
    expect(html).toContain("mission-chat-scroll");
    expect(html).toContain("mission-chat-footer");
    expect(html).toContain("mission-chat-composer");
    expect(html).toContain("mission-chat-composer-toolbar");
    expect(html).not.toContain("Used 0 tokens");
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

  it("uses one interrupt-or-send action and exposes queued-message shortcuts", () => {
    const mission = missionFixture("expert");
    mission.execution = {
      id: "00000000-0000-4000-8000-000000000010",
      inputMessageId: mission.initialMessageId,
      sessionId: "00000000-0000-4000-8000-000000000011",
      status: "running",
      startedAt: "2026-07-11T00:00:01.000Z",
    };
    const chat: MissionChatSnapshot = {
      missionId: mission.id,
      revision: 1,
      entries: [],
      page: {},
      pendingInteractions: [],
      queue: {
        state: "running",
        pendingCount: 1,
        supportsSteer: true,
        items: [
          {
            requestId: "00000000-0000-4000-8000-000000000012",
            content: "Adjust the implementation",
            hasAttachments: false,
          },
        ],
      },
      execution: {
        id: mission.execution.id,
        status: "running",
        interruptible: true,
      },
    };
    const html = renderToStaticMarkup(
      <MissionDetailFragment mission={mission} chatCache={new Map([[mission.id, chat]])} />,
    );

    expect(html).toContain('aria-label="Interrupt execution"');
    expect(html).not.toContain('aria-label="Send message"');
    expect(html).not.toContain('aria-label="Message delivery mode"');
    expect(html).toContain("mission-prompt-queue-item");
    expect(html).toContain(">Steer<");
    expect(html).toContain('aria-label="Remove from queue and edit"');
    expect(html).not.toContain("Execution running");
  });

  it("hides queued steer when the Runtime does not support it", () => {
    const mission = missionFixture("expert");
    const chat: MissionChatSnapshot = {
      missionId: mission.id,
      revision: 1,
      entries: [],
      page: {},
      pendingInteractions: [],
      queue: {
        state: "running",
        pendingCount: 1,
        supportsSteer: false,
        items: [
          {
            requestId: "00000000-0000-4000-8000-000000000012",
            content: "Queued content",
            hasAttachments: false,
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <MissionDetailFragment mission={mission} chatCache={new Map([[mission.id, chat]])} />,
    );

    expect(html).toContain("mission-prompt-queue-item");
    expect(html).not.toContain(">Steer<");
    expect(html).toContain('aria-label="Remove from queue and edit"');
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

describe("Mission work grid", () => {
  it("renders one expert card per work record with profiled avatars and status", () => {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const records: MissionWorkRecord[] = [
      {
        recordId: "root:coordinator",
        kind: "root",
        sessionId: "coordinator",
        title: "Coordinator",
        executorId: "coordinator",
        avatarId: "pragma.avatar.expert.07",
        origin: "core",
        status: "running",
        tasks: [],
        summary: "Coordinate the mission",
        createdAt,
        updatedAt: createdAt,
      },
      {
        recordId: "runtime-agent:researcher",
        kind: "runtime-agent",
        sessionId: "researcher",
        parentRecordId: "root:coordinator",
        title: "Researcher",
        avatarId: "pragma.avatar.expert.08",
        origin: "runtime",
        status: "succeeded",
        tasks: [],
        summary: "Inspect the repository",
        createdAt,
        updatedAt: createdAt,
      },
    ];

    const html = renderToStaticMarkup(
      <MissionWorkGrid records={records} onSelect={() => undefined} />,
    );

    expect(html.match(/class="mission-work-card /g)).toHaveLength(2);
    expect(html).toContain("Coordinator");
    expect(html).toContain("Researcher");
    expect(html).toContain('data-avatar-profile="pragma.avatar.expert.07"');
    expect(html).toContain('data-avatar-profile="pragma.avatar.expert.08"');
    expect(html).toContain("mission-work-grid-connections");
    expect(html).toContain("mission-work-description");
    expect(html).not.toContain("<h2");
    expect(html).toContain('markerWidth="9"');
    expect(html).toContain('markerUnits="userSpaceOnUse"');
    expect(html).toContain('data-density="pair"');
    expect(html).toContain("mission-work-call-order");
    expect(html).toContain("#1");
    expect(html).toContain("Call #1");
    expect(html).toMatch(
      /class="mission-work-grid" data-density="pair" role="list" aria-label="[^"]+"/u,
    );
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
  });

  it("uses a focused single-expert layout with a larger avatar and task summary", () => {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const html = renderToStaticMarkup(
      <MissionWorkGrid
        records={[
          {
            recordId: "root:coordinator",
            kind: "root",
            sessionId: "coordinator",
            title: "Coordinator",
            avatarId: "pragma.avatar.expert.07",
            origin: "core",
            status: "running",
            tasks: [],
            summary: "Coordinate the mission and prepare the final handoff.",
            createdAt,
            updatedAt: createdAt,
          },
        ]}
        onSelect={() => undefined}
      />,
    );

    expect(html).toContain('class="mission-work-list is-single is-sparse"');
    expect(html).toContain('data-density="single"');
    expect(html).toContain("pragma-avatar-lg");
    expect(html).toContain("mission-work-card-summary");
    expect(html).toContain("Coordinate the mission and prepare the final handoff.");
    expect(html).not.toContain("mission-work-call-order");
  });

  it("numbers non-root experts by their first call and uses stable record IDs for ties", () => {
    const base = {
      kind: "runtime-agent" as const,
      sessionId: "session",
      parentRecordId: "root",
      title: "Expert",
      origin: "runtime" as const,
      status: "succeeded" as const,
      tasks: [],
      summary: "Done",
      updatedAt: "2026-07-21T00:00:02.000Z",
    };
    const records: MissionWorkRecord[] = [
      {
        ...base,
        recordId: "child:b",
        createdAt: "2026-07-21T00:00:01.000Z",
      },
      {
        ...base,
        recordId: "root",
        kind: "root",
        parentRecordId: undefined,
        createdAt: "2026-07-21T00:00:00.000Z",
      },
      {
        ...base,
        recordId: "child:a",
        createdAt: "2026-07-21T00:00:01.000Z",
      },
      {
        ...base,
        recordId: "child:c",
        createdAt: "2026-07-21T00:00:02.000Z",
      },
    ];

    expect([...missionWorkCallOrder(records)]).toEqual([
      ["child:a", 1],
      ["child:b", 2],
      ["child:c", 3],
    ]);
  });

  it("keeps arrow heads outside the target card for vertical and horizontal layouts", () => {
    const source = { top: 10, right: 110, bottom: 110, left: 10, width: 100, height: 100 };
    const verticalTarget = {
      top: 210,
      right: 310,
      bottom: 310,
      left: 210,
      width: 100,
      height: 100,
    };
    const horizontalTarget = {
      top: 10,
      right: 310,
      bottom: 110,
      left: 210,
      width: 100,
      height: 100,
    };

    expect(
      missionWorkGridEdgePath({
        source,
        target: verticalTarget,
        surface: { left: 0, top: 0 },
      }),
    ).toBe("M 60 110 V 155 H 260 V 200");
    expect(
      missionWorkGridEdgePath({
        source,
        target: horizontalTarget,
        surface: { left: 0, top: 0 },
      }),
    ).toBe("M 110 60 H 200");
  });

  it("uses one shared horizontal trunk for sibling branches", () => {
    const source = { top: 10, right: 210, bottom: 110, left: 110, width: 100, height: 100 };
    const leftTarget = {
      top: 210,
      right: 110,
      bottom: 310,
      left: 10,
      width: 100,
      height: 100,
    };
    const rightTarget = {
      top: 210,
      right: 310,
      bottom: 310,
      left: 210,
      width: 100,
      height: 100,
    };

    expect(
      missionWorkGridEdgePath({
        source,
        target: leftTarget,
        surface: { left: 0, top: 0 },
      }),
    ).toBe("M 160 110 V 155 H 60 V 200");
    expect(
      missionWorkGridEdgePath({
        source,
        target: rightTarget,
        surface: { left: 0, top: 0 },
      }),
    ).toBe("M 160 110 V 155 H 260 V 200");
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
  it("preserves known history and interaction state when a refresh is degraded", () => {
    const current: MissionChatSnapshot = {
      missionId: "00000000-0000-4000-8000-000000000000",
      revision: 1,
      entries: [
        {
          id: "answer",
          kind: "assistant",
          content: "Previously loaded answer",
          streaming: false,
          createdAt: "2026-07-11T00:00:00.000Z",
        },
      ],
      page: {},
      pendingInteractions: [
        {
          interactionId: "question",
          request: {
            kind: "question",
            questions: [
              {
                question: "Continue?",
                header: "Continue",
                kind: "single_choice",
                options: [{ label: "Yes", description: "Continue." }],
              },
            ],
          },
        },
      ],
    };
    const degraded: MissionChatSnapshot = {
      missionId: current.missionId,
      revision: 2,
      entries: [],
      page: {},
      pendingInteractions: [],
      syncIssues: [
        {
          code: "execution_state_unavailable",
          section: "history",
          retryable: true,
        },
        {
          code: "execution_state_unavailable",
          section: "pending_interactions",
          retryable: true,
        },
      ],
    };

    expect(mergeLatestChatPage(current, degraded)).toMatchObject({
      revision: 2,
      entries: [{ id: "answer", content: "Previously loaded answer" }],
      pendingInteractions: [{ interactionId: "question" }],
    });
  });

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

  it("keeps executor presentation metadata when a live upsert omits it", () => {
    const snapshot: MissionChatSnapshot = {
      missionId: "00000000-0000-4000-8000-000000000000",
      revision: 1,
      entries: [
        {
          id: "answer",
          kind: "assistant",
          executorId: "writer",
          executorName: "Writer",
          executorAvatarId: "pragma.avatar.expert.07",
          content: "Drafting",
          streaming: true,
          createdAt: "2026-07-11T00:00:00.000Z",
        },
      ],
      page: {},
      pendingInteractions: [],
    };

    expect(
      applyMissionChatPatches(
        snapshot,
        [
          {
            type: "entry.upsert",
            entry: {
              id: "answer",
              kind: "assistant",
              executorId: "writer",
              content: "Draft complete.",
              streaming: false,
              createdAt: "2026-07-11T00:00:00.000Z",
            },
          },
        ],
        2,
      ),
    ).toMatchObject({
      entries: [
        {
          executorName: "Writer",
          executorAvatarId: "pragma.avatar.expert.07",
        },
      ],
    });
  });

  it("applies a live context-window patch without replacing chat entries", () => {
    const snapshot: MissionChatSnapshot = {
      missionId: "00000000-0000-4000-8000-000000000000",
      revision: 1,
      entries: [],
      page: {},
      pendingInteractions: [],
      contextWindow: {
        supportsInspection: true,
        supportsCompaction: true,
        canCompact: false,
      },
    };

    expect(
      applyMissionChatPatches(
        snapshot,
        [
          {
            type: "context-window.update",
            usage: {
              usedTokens: 80_000,
              contextWindowTokens: 200_000,
              percent: 40,
              measurement: "estimated",
              observedAt: "2026-07-29T00:00:00.000Z",
            },
          },
        ],
        2,
      ),
    ).toMatchObject({
      revision: 2,
      contextWindow: {
        canCompact: false,
        usage: { usedTokens: 80_000, percent: 40 },
      },
    });
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

  it("splits consecutive tool calls when the active Expert changes", () => {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const blocks = groupMissionConversationEntries(
      [
        ["tool-1", "call-1", "writer"],
        ["tool-2", "call-2", "researcher"],
        ["tool-3", "call-3", "researcher"],
      ].map(([id, toolCallId, executorId]) => ({
        type: "durable" as const,
        entry: {
          id: id!,
          kind: "tool" as const,
          toolCallId: toolCallId!,
          toolName: "read_file",
          status: "succeeded" as const,
          executorId: executorId!,
          createdAt,
        },
      })),
    );

    expect(blocks).toMatchObject([
      { type: "tools", entries: [{ id: "tool-1" }] },
      { type: "tools", entries: [{ id: "tool-2" }, { id: "tool-3" }] },
    ]);
  });

  it("does not collide an Expert ID with another entry's name", () => {
    const createdAt = "2026-07-21T00:00:00.000Z";
    const blocks = groupMissionConversationEntries([
      {
        type: "durable",
        entry: {
          id: "tool-by-id",
          kind: "tool",
          executorId: "shared-value",
          toolCallId: "call-by-id",
          toolName: "read_file",
          status: "succeeded",
          createdAt,
        },
      },
      {
        type: "durable",
        entry: {
          id: "tool-by-name",
          kind: "tool",
          executorName: "shared-value",
          toolCallId: "call-by-name",
          toolName: "search_files",
          status: "succeeded",
          createdAt,
        },
      },
    ]);

    expect(blocks).toMatchObject([
      { type: "tools", entries: [{ id: "tool-by-id" }] },
      { type: "tools", entries: [{ id: "tool-by-name" }] },
    ]);
  });
});

describe("Mission Expert output labels", () => {
  const createdAt = "2026-07-21T00:00:00.000Z";

  it("renders Mission image previews and file attachment labels", () => {
    const html = renderToStaticMarkup(
      <MissionChatEntryView
        missionId="00000000-0000-4000-8000-000000000001"
        entry={{
          id: "message",
          kind: "user",
          content: "Summarize these inputs.",
          attachments: [
            {
              id: "00000000-0000-4000-8000-000000000002",
              kind: "image",
              name: "screen.png",
              path: "/mission/attachments/images/screen.png",
              mimeType: "image/png",
            },
            {
              id: "00000000-0000-4000-8000-000000000003",
              kind: "file",
              name: "notes.txt",
              path: "/workspace/notes.txt",
            },
          ],
          createdAt,
        }}
      />,
    );

    expect(html).toContain(
      "pragma-mission-attachment://preview/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002",
    );
    expect(html).toContain("screen.png");
    expect(html).toContain("notes.txt");
    expect(html).toContain("mission-attachment-label");
  });

  it("shows the Expert name and avatar on output without repeating it on tool groups", () => {
    const answer = renderToStaticMarkup(
      <MissionChatEntryView
        entry={{
          id: "answer",
          kind: "assistant",
          executorId: "writer",
          executorName: "Writer",
          executorAvatarId: "pragma.avatar.expert.07",
          content: "Draft complete.",
          streaming: false,
          createdAt,
        }}
        showExecutorLabel
      />,
    );
    const thinking = renderToStaticMarkup(
      <MissionThinkingEntry
        entry={{
          id: "thinking",
          kind: "thinking",
          executorId: "researcher",
          executorName: "Researcher",
          executorAvatarId: "pragma.avatar.expert.08",
          content: "Inspecting sources.",
          streaming: true,
          createdAt,
        }}
        showExecutorLabel
      />,
    );
    const tools = renderToStaticMarkup(
      <MissionToolCallBlock
        collapsed
        entries={[
          {
            id: "tool-1",
            kind: "tool",
            executorId: "reviewer",
            executorName: "Reviewer",
            toolCallId: "call-1",
            toolName: "read_file",
            status: "succeeded",
            createdAt,
          },
          {
            id: "tool-2",
            kind: "tool",
            executorId: "reviewer",
            executorName: "Reviewer",
            toolCallId: "call-2",
            toolName: "search_files",
            status: "succeeded",
            createdAt,
          },
        ]}
      />,
    );

    expect(answer).toContain('data-mission-executor-id="writer"');
    expect(answer).toContain(">Writer<");
    expect(answer).toContain(expertAvatarSource("pragma.avatar.expert.07"));
    expect(thinking).toContain('data-mission-executor-id="researcher"');
    expect(thinking).toContain(">Researcher<");
    expect(thinking).toContain(expertAvatarSource("pragma.avatar.expert.08"));
    expect(tools).not.toContain("data-mission-executor-id");
    expect(tools).not.toContain("Reviewer");
  });

  it("keeps tool failure diagnostics expandable without announcing the raw error", () => {
    const html = renderToStaticMarkup(
      <MissionToolCallBlock
        collapsed
        entries={[
          {
            id: "tool-failed",
            kind: "tool",
            executorId: "reviewer",
            executorName: "Reviewer",
            toolCallId: "call-failed",
            toolName: "bash",
            status: "failed",
            error: "Command exited with status 1.",
            createdAt,
          },
        ]}
      />,
    );

    expect(html).toContain("is-failed");
    expect(html).toContain("Command exited with status 1.");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Reviewer");
  });

  it("falls back to the Expert ID and keeps Work drawer output labels suppressed", () => {
    const fallback = renderToStaticMarkup(
      <MissionChatEntryView
        entry={{
          id: "answer",
          kind: "assistant",
          executorId: "expert-without-name",
          content: "Done.",
          streaming: false,
          createdAt,
        }}
        showExecutorLabel
      />,
    );
    const work = renderToStaticMarkup(
      <MissionWorkDrawer
        record={{
          recordId: "runtime-agent:researcher",
          kind: "runtime-agent",
          sessionId: "researcher",
          title: "Runtime Researcher",
          origin: "runtime",
          status: "running",
          tasks: [],
          summary: "Inspect",
          createdAt,
          updatedAt: createdAt,
        }}
        inputSenderName="Main agent"
        entries={[
          {
            id: "answer",
            kind: "assistant",
            executorId: "parent-expert",
            executorName: "Parent Expert",
            content: "Runtime child output.",
            streaming: false,
            createdAt,
          },
        ]}
        loading={false}
        onClose={() => undefined}
      />,
    );

    expect(fallback).toContain(">expert-without-name<");
    expect(work).toContain("Runtime Researcher");
    expect(work).not.toContain("mission-output-executor");
    expect(work).not.toContain("Parent Expert");
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
      <MissionThinkingEntry
        entry={{ ...entry, streaming: true }}
        paintExecutionId="execution-visible"
      />,
    );

    expect(html).toContain("mission-thinking-entry is-expanded is-streaming");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-mission-execution-id="execution-visible"');
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

describe("Mission human answers", () => {
  const questions = [
    {
      header: "Direction",
      question: "Which direction should we take?",
      kind: "single_choice",
      options: [{ label: "Option one", description: "The first route." }],
    },
    {
      header: "Audience",
      question: "Who is this for?",
      kind: "multiple_choice",
      options: [{ label: "Designers", description: "Design teams." }],
    },
    {
      header: "Details",
      question: "What should the agent know?",
      kind: "text",
      options: [],
    },
  ] satisfies readonly MissionHumanQuestion[];

  it("requires every question to have an option, custom answer, or text answer", () => {
    expect(hasValidMissionHumanAnswers(questions, {}, {})).toBe(false);
    expect(
      hasValidMissionHumanAnswers(
        questions,
        {
          "Who is this for?": ["Designers"],
          "What should the agent know?": "Keep it compact.",
        },
        {},
      ),
    ).toBe(false);
    expect(
      hasValidMissionHumanAnswers(
        questions,
        {
          "Who is this for?": ["Designers"],
          "What should the agent know?": "Keep it compact.",
        },
        { "Which direction should we take?": "A different route." },
      ),
    ).toBe(true);
    expect(
      hasValidMissionHumanAnswers(
        questions,
        {
          "Who is this for?": ["Designers"],
          "What should the agent know?": "Keep it compact.",
        },
        { "Which direction should we take?": "   " },
      ),
    ).toBe(false);
  });

  it("submits custom answers in place of selected options without losing other questions", () => {
    expect(
      mergeMissionHumanAnswers(
        {
          "Which direction should we take?": "Option one",
          "Who is this for?": ["Designers"],
          "What should the agent know?": "Keep it compact.",
        },
        {
          "Which direction should we take?": "A different route.",
          "Who is this for?": "A broader audience.",
        },
      ),
    ).toEqual({
      "Which direction should we take?": "A different route.",
      "Who is this for?": "A broader audience.",
      "What should the agent know?": "Keep it compact.",
    });
  });
});

function missionFixture(kind: "expert" | "team"): Mission {
  return {
    schemaVersion: "pragma.mission/v7",
    origin: { type: "user" },
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
  readonly source?: MissionSummary["source"] | undefined;
  readonly updatedAt: string;
}): MissionSummary {
  return {
    id: input.id,
    title: input.title,
    workspace: { basename: "expert-mesh" },
    executor: { kind: "expert", name: "Product Designer" },
    ...(input.status === undefined ? {} : { execution: { status: input.status } }),
    source: input.source ?? { type: "task" },
    lifecycleStatus: input.lifecycleStatus ?? "active",
    updatedAt: input.updatedAt,
  };
}
