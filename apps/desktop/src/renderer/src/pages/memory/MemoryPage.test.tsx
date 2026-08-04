import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import { MemoryDegradedAlert, MemoryPage } from "./MemoryPage.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("MemoryPage", () => {
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
