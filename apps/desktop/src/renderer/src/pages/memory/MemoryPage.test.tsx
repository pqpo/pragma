import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  MemoryActionWithTooltip,
  MemoryDegradedAlert,
  MemoryExtractionJobs,
  MemoryHealth,
  MemoryPage,
  canRunMemoryAction,
  formatMemorySubjectRefs,
  memoryExtractionPollDelay,
} from "./MemoryPage.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("MemoryPage", () => {
  it("shows human-readable subject names while preserving canonical memory references", () => {
    expect(
      formatMemorySubjectRefs(
        [
          { type: "pragma.expert-team", id: "r5pjstt2yftkg8dx" },
          { type: "pragma.expert", id: "missing" },
        ],
        { "pragma.expert-team:r5pjstt2yftkg8dx": "AI研发团队" },
      ),
    ).toBe("AI研发团队(pragma.expert-team:r5pjstt2yftkg8dx), pragma.expert:missing");
    expect(formatMemorySubjectRefs([])).toBe("—");
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

  it("does not require a Fact reason for Knowledge initialization candidate actions", () => {
    expect(canRunMemoryAction("knowledge-initialization", "")).toBe(true);
    expect(canRunMemoryAction("memory-governance", "")).toBe(false);
    expect(canRunMemoryAction("memory-governance", "confirmed by the user")).toBe(true);
  });

  it("renders the first-level layered Memory management entry", () => {
    const html = renderToStaticMarkup(<MemoryPage />);

    expect(html).toContain("<h1>Memory</h1>");
    expect(html).toContain("Episodes");
    expect(html).toContain("Facts");
    expect(html).toContain("Health");
    expect(html).toContain("Search memory");
  });

  it("provides Simplified Chinese copy", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(<MemoryPage />);

    expect(html).toContain("<h1>记忆</h1>");
    expect(html).toContain("情景记忆");
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

  it("renders the four-lane extraction board with compact, human-readable tasks", () => {
    const html = renderToStaticMarkup(
      <MemoryExtractionJobs
        board={{
          lanes: {
            waiting: {
              tasks: [
                {
                  module: "episodic",
                  id: "internal-job-a",
                  revision: 1,
                  lane: "waiting",
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
                  lastErrorCode: "knowledge_candidate_capacity_exceeded",
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

    expect(html).toContain("Waiting for idle");
    expect(html).toContain("Review and manage queued, active, and completed memory refinements.");
    expect(html).not.toContain(">Extraction jobs</");
    expect(html).toContain("Needs attention");
    expect(html).toContain("In progress");
    expect(html).toContain("Completed");
    expect(html).toContain("Prepare the release");
    expect(html).toContain("Episodic memory");
    expect(html).toContain("Knowledge memory");
    expect(html).toContain("knowledge_candidate_capacity_exceeded");
    expect(html).toContain("Extract now");
    expect(html).toContain("Retry extraction");
    expect(html).toContain("Delete");
    expect(html).not.toContain("internal-job-a");
    expect(html).not.toContain("Evidence records");
  });

  it("shows extraction failures without requiring the Health tab", async () => {
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
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("记忆提取需要处理");
    expect(html).toContain("memory_curator_failed");
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
    expect(html).toContain("canonical_event_handoff_quarantined");
    expect(html).toContain("memory_curator_failed");
  });
});
