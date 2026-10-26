import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  MemoryActionWithTooltip,
  MemoryDegradedAlert,
  MemoryExtractionJobs,
  MemoryExtractionTaskDetails,
  MemoryHealth,
  MemoryItemContent,
  MemoryPage,
  MemoryListLoadMore,
  formatMemorySubjectRefs,
  memoryExtractionPollDelay,
  memoryExtractionTaskTitle,
} from "./MemoryPage.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("MemoryPage", () => {
  it.each([false, true])("shows the completed lane only when selected (%s)", (showCompleted) => {
    const empty = { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 };
    const html = renderToStaticMarkup(
      <MemoryExtractionJobs
        showCompleted={showCompleted}
        onToggleCompleted={() => undefined}
        loading={false}
        onRefresh={() => undefined}
        onAction={async () => undefined}
        onPageChange={() => undefined}
        board={{
          lanes: {
            waiting: empty,
            attention: empty,
            running: empty,
            completed: {
              ...empty,
              totalTasks: 1,
              tasks: [
                {
                  module: "conversation",
                  id: "old",
                  revision: 1,
                  lane: "completed",
                  title: "An old task",
                  updatedAt: "2026-10-18T01:20:00.000Z",
                },
              ],
            },
          },
        }}
      />,
    );
    expect(html.includes("An old task")).toBe(showCompleted);
    expect(html.includes("memory-extraction-lane is-completed")).toBe(showCompleted);
    expect(html).toContain(`aria-pressed="${showCompleted}"`);
    expect(html).toContain(showCompleted ? "Hide completed tasks" : "Show completed tasks");
  });

  it("uses topics as task titles and distinguishes historical learning tasks by creation time", () => {
    const task = {
      module: "knowledge" as const,
      id: "job",
      revision: 1,
      lane: "completed" as const,
      updatedAt: "2026-10-18T14:00:00.000Z",
      createdAt: "2026-10-18T01:20:00.000Z",
      sourceName: "Pragma",
    };
    expect(
      memoryExtractionTaskTitle({ ...task, title: "ContextStore token savings", topicCount: 3 }),
    ).toBe("ContextStore token savings · 3 topics");
    expect(memoryExtractionTaskTitle(task)).toContain("Knowledge extraction");
    expect(memoryExtractionTaskTitle(task)).not.toContain("Pragma");
    expect(memoryExtractionTaskTitle({ ...task, updatedAt: "2026-10-18T15:00:00.000Z" })).toBe(
      memoryExtractionTaskTitle(task),
    );
  });
  it("offers keyboard loading and retry while announcing pagination state", () => {
    const props = { loading: false, hasMore: true, error: false, loadMore: async () => {} };
    const more = renderToStaticMarkup(<MemoryListLoadMore {...props} />);
    expect(more).toContain("Load more");
    expect(more).toContain('type="button"');
    const loading = renderToStaticMarkup(<MemoryListLoadMore {...props} loading />);
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain("Load more");
    expect(loading).toContain('aria-disabled="true"');
    const retry = renderToStaticMarkup(<MemoryListLoadMore {...props} error />);
    expect(retry).toContain('role="alert"');
    expect(retry).toContain("Retry");
    const end = renderToStaticMarkup(<MemoryListLoadMore {...props} hasMore={false} />);
    expect(end).not.toContain("<button");
  });

  it("shows subject names and a readable fallback without exposing resource references", () => {
    expect(
      formatMemorySubjectRefs(
        [
          { type: "pragma.expert-team", id: "r5pjstt2yftkg8dx" },
          { type: "pragma.expert", id: "missing" },
        ],
        { "pragma.expert-team:r5pjstt2yftkg8dx": "AI研发团队" },
      ),
    ).toBe("AI研发团队, Unavailable resource");
    expect(formatMemorySubjectRefs([])).toBe("—");
  });

  it("renders a fact once as readable body text without a duplicate heading", () => {
    const statement = "Screenshot callbacks notify the registered listeners.";
    const html = renderToStaticMarkup(
      <MemoryItemContent
        item={{ module: "semantic", title: statement, summary: statement, status: "active" }}
      />,
    );
    expect(html.split(statement)).toHaveLength(2);
    expect(html).not.toContain("<h2>");
    expect(html).toContain("Active");
  });

  it("shows fact confidence and human verification separately", () => {
    const fact = {
      module: "semantic" as const,
      title: "A fact",
      summary: "A fact",
      status: "active" as const,
      confidence: 0.85,
    };
    const html = renderToStaticMarkup(<MemoryItemContent item={fact} />);
    expect(html).toContain("Confidence 85%");
    expect(html).not.toContain("Manually verified");
    const verified = renderToStaticMarkup(
      <MemoryItemContent item={{ ...fact, confidence: 1, verifiedAt: "2026-10-15T00:00:00Z" }} />,
    );
    expect(verified).toContain("Confidence 100%");
    expect(verified).toContain("Manually verified");
  });

  it("keeps a distinct episode title but omits a title repeated by the summary", () => {
    const item = {
      module: "episodic" as const,
      title: "Investigate screenshots",
      summary: "The callback is separate from image saving.",
      status: "invalidated" as const,
    };
    const html = renderToStaticMarkup(<MemoryItemContent item={item} />);
    expect(html).toContain("<h2>Investigate screenshots</h2>");
    expect(html).toContain(item.summary);
    expect(html).toContain("Invalidated");
    const repeated = renderToStaticMarkup(
      <MemoryItemContent item={{ ...item, title: ` ${item.summary} ` }} />,
    );
    expect(repeated).not.toContain("<h2>");
    expect(repeated.split(item.summary)).toHaveLength(2);
  });

  it("polls active extraction work quickly and terminal boards at a lower idle cadence", () => {
    expect(
      memoryExtractionPollDelay({
        lanes: {
          waiting: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 1 },
          attention: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
          running: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
          completed: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
        },
      }),
    ).toBe(2_000);
    expect(
      memoryExtractionPollDelay({
        lanes: {
          waiting: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
          attention: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 1 },
          running: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
          completed: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 4 },
        },
      }),
    ).toBe(10_000);
  });

  it("renders vertical memory navigation with independent navigation and list resize handles", () => {
    const html = renderToStaticMarkup(<MemoryPage />);

    expect(html).toContain("<h1>All memories</h1>");
    expect(html).toContain('role="combobox" aria-label="Memory type"');
    expect(html).toContain("All memories");
    expect(html).not.toContain(">Episodes</button>");
    expect(html).not.toContain(">Facts</button>");
    expect(html).toContain("Health");
    expect(html).toContain("Search memory");
    expect(html.match(/role="separator"/g)).toHaveLength(2);
    expect(html).toContain('class="memory-navigation"');
    expect(html).toContain('class="memory-content"');
    expect(html).not.toContain("memory-tabs");
    expect(html).toContain('aria-label="Resize memory list"');
  });

  it("provides Simplified Chinese copy", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(<MemoryPage />);

    expect(html).toContain("<h1>全部记忆</h1>");
    expect(html).toContain("全部记忆");
    expect(html).not.toContain(">情景记忆</button>");
    expect(html).not.toContain(">事实</button>");
    expect(html).toContain("健康状态");
  });

  it("presents health as a scannable overview without repeating the selected tab title", () => {
    const html = renderToStaticMarkup(
      <MemoryHealth
        health={{
          state: "running",
          feed: {
            lastSequence: 1_325,
            eventCount: 1_325,
            logicalBytes: 2.7 * 1_024 * 1_024,
            fileBytes: 3 * 1_024 * 1_024,
            receiptCount: 1_325,
            safeThroughSequence: 200,
            blockedBytes: 0,
          },
          delivery: { pending: 0, quarantined: 0 },
          modules: [
            {
              moduleId: "pragma.memory.episodic",
              moduleVersion: "1.0.0",
              status: "healthy",
              lag: 0,
              processed: 1_325,
              retried: 0,
              deadLettered: 0,
              skipped: 0,
              work: {
                records: 4,
                pending: 1,
                running: 0,
                needsAttention: 0,
                rejected: 9,
                expired: 0,
                evidenceRecords: 8,
                evidenceBytes: 1_024,
                truncatedExecutions: 0,
              },
              updatedAt: "2026-08-05T00:00:00.000Z",
            },
          ],
          hostDelivery: [
            { moduleId: "pragma.mission-deletion", state: "healthy", pending: 0 },
            { moduleId: "pragma.mission-delivery", state: "healthy", pending: 615 },
            {
              moduleId: "pragma.local-host-usage",
              state: "degraded",
              pending: 2,
              errorCode: "USAGE_DELIVERY_RETRY_PENDING",
            },
          ],
          maintenance: {
            deletedEvents: 0,
            reclaimedBytes: 0,
            deletedDeadLetters: 0,
            deadLetterEntries: 0,
            deadLetterBytes: 0,
          },
        }}
      />,
    );

    expect(html).toContain('aria-label="Health"');
    expect(html).not.toContain("<h2>Health</h2>");
    expect(html).toContain("Memory is running normally");
    expect(html).toContain("Feed storage");
    expect(html).toContain("Module status");
    expect(html).toContain("Episodic memory");
    expect(html).toContain("pragma.memory.episodic@1.0.0");
    expect(html).toContain('aria-label="Storage usage"');
    const services = html.slice(html.indexOf('<section class="memory-health-services"'));
    const modules = html.slice(0, html.indexOf('<section class="memory-health-services"'));
    expect(services).toContain("Background services");
    expect(services).toContain("Task cleanup");
    expect(services).toContain("Task result syncing");
    expect(services).toContain("Usage accounting");
    expect(services).toContain("Pending items");
    expect(services).toContain("<td>615</td>");
    expect(services).toContain("Needs attention");
    expect(services).toContain("USAGE_DELIVERY_RETRY_PENDING");
    expect(services).not.toContain("<td>—</td>");
    expect(services).not.toContain("pragma.mission-delivery");
    expect(modules).not.toContain("Task result syncing");
  });

  it("describes governance actions with an accessible tooltip", () => {
    const html = renderToStaticMarkup(
      <MemoryActionWithTooltip
        disabled={false}
        label="Restrict visibility"
        tooltip="Only root asset principals will be able to discover this memory."
        onClick={() => undefined}
      />,
    );

    expect(html).toContain('aria-describedby="');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("Only root asset principals");
  });

  it("shows only running and attention tasks in task details", () => {
    const html = renderToStaticMarkup(
      <MemoryExtractionTaskDetails
        tasks={(["waiting", "attention", "running", "completed"] as const).map((lane) => ({
          module: "episodic",
          id: `${lane}-job`,
          revision: 1,
          lane,
          title: `${lane} task title`,
          updatedAt: "2026-10-15T00:00:00.000Z",
        }))}
      />,
    );
    expect(html).toContain("--sidebar-width:280px");
    expect(html).toContain('role="separator" aria-label="Resize task list"');
    expect(html).toContain('aria-valuemin="200" aria-valuemax="420" aria-valuenow="280"');
    expect(html).toContain("attention task title");
    expect(html).toContain("running task title");
    expect(html).not.toContain("waiting task title");
    expect(html).not.toContain("completed task title");

    const empty = renderToStaticMarkup(
      <MemoryExtractionTaskDetails
        tasks={[
          {
            module: "episodic",
            id: "waiting-job",
            revision: 1,
            lane: "waiting",
            updatedAt: "2026-10-15T00:00:00.000Z",
          },
        ]}
      />,
    );
    expect(empty).toContain("There are no active refinements or tasks needing attention.");
    expect(empty).toContain('class="empty-state memory-task-details-empty"');
    expect(empty).not.toContain("memory-task-detail-item");
    expect(empty).not.toContain("<aside");
    expect(empty).not.toContain("<main");
    expect(empty).not.toContain('role="separator"');
    expect(empty).not.toContain("Select a task to inspect its refinement activity.");
  });

  it.each(["loading", "error", "hasMore"] as const)(
    "preserves %s controls when task details have no loaded tasks",
    (state) => {
      const html = renderToStaticMarkup(
        <MemoryExtractionTaskDetails
          tasks={[]}
          pagination={{
            loading: state === "loading",
            error: state === "error",
            hasMore: state === "hasMore",
            loadMore: async () => {},
          }}
        />,
      );
      expect(html).not.toContain("There are no active refinements or tasks needing attention.");
      expect(html).not.toContain("<aside");
      expect(html).toContain("<button");
      expect(html).toContain(
        state === "loading" ? 'role="status"' : state === "error" ? "Retry" : "Load more",
      );
    },
  );

  it("explains and disables a queued knowledge action when learning is off", () => {
    const empty = { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 };
    const html = renderToStaticMarkup(
      <MemoryExtractionJobs
        showCompleted={true}
        onToggleCompleted={() => undefined}
        learningEnabled={false}
        loading={false}
        onRefresh={() => undefined}
        onAction={async () => undefined}
        onPageChange={() => undefined}
        board={{
          lanes: {
            waiting: {
              ...empty,
              totalTasks: 1,
              tasks: [
                {
                  module: "knowledge",
                  id: "job",
                  revision: 1,
                  lane: "waiting",
                  title: "Store Revision Agent",
                  updatedAt: "2026-10-18T14:01:33.844Z",
                },
              ],
            },
            attention: empty,
            running: empty,
            completed: empty,
          },
        }}
      />,
    );
    expect(html).toContain("Knowledge and Skill learning is disabled.");
    expect(html).toContain('role="status"');
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(1);
  });

  it("keeps waiting tasks and the expedite action available alongside other lanes", () => {
    const html = renderToStaticMarkup(
      <MemoryExtractionJobs
        showCompleted={true}
        onToggleCompleted={() => undefined}
        board={{
          lanes: {
            waiting: {
              tasks: [
                {
                  module: "episodic",
                  id: "internal-job-a",
                  revision: 1,
                  lane: "waiting",
                  recovery: "waiting_execution",
                  retryAt: "2026-08-05T00:00:05.000Z",
                  title: "Prepare the release",
                  updatedAt: "2026-08-05T00:00:00.000Z",
                },
              ],
              pageIndex: 0,
              pageCount: 1,
              totalTasks: 1,
            },
            attention: {
              tasks: [
                {
                  module: "knowledge",
                  id: "internal-job-b",
                  revision: 3,
                  lane: "attention",
                  title: "Pragma",
                  problem: {
                    kind: "capacity",
                    technicalCode: "knowledge_candidate_capacity_exceeded",
                  },
                  updatedAt: "2026-08-05T01:00:00.000Z",
                },
              ],
              pageIndex: 0,
              pageCount: 1,
              totalTasks: 1,
            },
            running: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
            completed: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
          },
        }}
        loading={false}
        onRefresh={() => undefined}
        onAction={async () => undefined}
        onPageChange={() => undefined}
      />,
    );

    expect(html).toContain("Waiting for execution result");
    expect(html).toContain("Next check:");
    expect(html).toContain("Waiting for idle");
    expect(html).toContain("memory-extraction-lane is-waiting");
    expect(html).toContain("Track refinement progress and manage tasks that need your attention.");
    expect(html).toContain("<h1>Extraction jobs</h1>");
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain("Needs attention");
    expect(html).toContain("In progress");
    expect(html).toContain("Completed");
    expect(html).toContain("Prepare the release");
    expect(html).toContain("Episodic memory");
    expect(html).toContain("Knowledge extraction");
    expect(html).toContain("Memory capacity needs attention");
    expect(html).toContain("Technical details");
    expect(html).toContain("knowledge_candidate_capacity_exceeded");
    expect(html.indexOf("<details")).toBeLessThan(
      html.indexOf("knowledge_candidate_capacity_exceeded"),
    );
    expect(html).toContain("Extract now");
    expect(html.match(/aria-label="Retry extraction"/g)).toHaveLength(1);
    expect(html).not.toContain("Review candidates");
    expect(html).toContain("Abandon this extraction");
    expect(html).not.toContain("internal-job-a");
    expect(html).not.toContain("Evidence records");
  });

  it("presents rejected completed extraction as a neutral result without recovery actions", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(
      <MemoryExtractionJobs
        showCompleted={true}
        onToggleCompleted={() => undefined}
        board={{
          lanes: {
            waiting: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
            attention: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
            running: { tasks: [], pageIndex: 0, pageCount: 1, totalTasks: 0 },
            completed: {
              tasks: [
                {
                  module: "skill",
                  id: "skill-job",
                  revision: 5,
                  lane: "completed",
                  title: "研发专家团",
                  completion: "rejected",
                  updatedAt: "2026-08-05T00:00:03.000Z",
                },
              ],
              pageIndex: 0,
              pageCount: 1,
              totalTasks: 1,
            },
          },
        }}
        loading={false}
        onRefresh={() => undefined}
        onAction={async () => undefined}
        onPageChange={() => undefined}
      />,
    );

    expect(html).toContain("研发专家团");
    expect(html).toContain("未产生新内容");
    expect(html).not.toContain("skill_source_threshold_not_met");
    expect(html).not.toContain("重新提炼");
    expect(html).not.toContain(">删除<");
  });

  it("shows extraction failures without requiring the Health tab", async () => {
    await i18n.changeLanguage("zh-Hans");
    const alert = (
      <MemoryDegradedAlert
        onViewTasks={() => undefined}
        health={{
          state: "degraded",
          feed: {
            lastSequence: 4,
            eventCount: 4,
            logicalBytes: 0,
            fileBytes: 0,
            receiptCount: 0,
            safeThroughSequence: 0,
            blockedBytes: 0,
          },
          delivery: { pending: 0, quarantined: 0 },
          lastError: {
            code: "memory_curator_failed",
            occurredAt: "2026-08-04T00:00:00.000Z",
          },
          modules: [
            {
              moduleId: "pragma.memory.episodic",
              moduleVersion: "1.0.0",
              status: "degraded",
              lag: 0,
              processed: 4,
              retried: 0,
              deadLettered: 0,
              skipped: 0,
              lastErrorCode: "memory_curator_failed",
              work: {
                records: 0,
                pending: 0,
                running: 0,
                needsAttention: 1,
                rejected: 0,
                expired: 0,
                evidenceRecords: 2,
                evidenceBytes: 512,
                truncatedExecutions: 0,
              },
              updatedAt: "2026-08-04T00:00:00.000Z",
            },
          ],
          maintenance: {
            deletedEvents: 0,
            reclaimedBytes: 0,
            deletedDeadLetters: 0,
            deadLetterEntries: 0,
            deadLetterBytes: 0,
          },
        }}
      />
    );

    const html = renderToStaticMarkup(alert);
    expect(html).toContain("查看提炼任务");
    expect(html).toContain('role="alert"');
    expect(html).toContain("记忆提取需要处理");
    expect(html).toContain('aria-label="关闭提示"');
    expect(html).toContain('class="memory-alert-close"');
    expect(html).not.toContain("memory_curator_failed");
  });

  it("does not hide a concurrent delivery failure behind extraction wording", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(
      <MemoryDegradedAlert
        health={{
          state: "degraded",
          feed: {
            lastSequence: 4,
            eventCount: 4,
            logicalBytes: 0,
            fileBytes: 0,
            receiptCount: 0,
            safeThroughSequence: 0,
            blockedBytes: 0,
          },
          delivery: { pending: 1, quarantined: 1 },
          lastError: {
            code: "canonical_event_handoff_quarantined",
            occurredAt: "2026-08-04T00:00:00.000Z",
          },
          modules: [
            {
              moduleId: "pragma.memory.episodic",
              moduleVersion: "1.0.0",
              status: "degraded",
              lag: 0,
              processed: 4,
              retried: 0,
              deadLettered: 0,
              skipped: 0,
              lastErrorCode: "memory_curator_failed",
              work: {
                records: 0,
                pending: 0,
                running: 0,
                needsAttention: 1,
                rejected: 0,
                expired: 0,
                evidenceRecords: 2,
                evidenceBytes: 512,
                truncatedExecutions: 0,
              },
              updatedAt: "2026-08-04T00:00:00.000Z",
            },
          ],
          maintenance: {
            deletedEvents: 0,
            reclaimedBytes: 0,
            deletedDeadLetters: 0,
            deadLetterEntries: 0,
            deadLetterBytes: 0,
          },
        }}
      />,
    );

    expect(html).toContain("记忆系统异常");
    expect(html).not.toContain("记忆提取需要处理");
    expect(html).not.toContain("canonical_event_handoff_quarantined");
    expect(html).not.toContain("memory_curator_failed");
  });
});
