import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  buildRevisionLineDiff,
  ContextStoreRevisionDiffFragment,
  ContextStoreRevisionFragment,
} from "./ContextStoreRevisionFragment.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("ContextStoreRevisionFragment", () => {
  it("renders revision activity as a knowledge-base secondary page", () => {
    const html = renderToStaticMarkup(
      <ContextStoreRevisionFragment stores={[]} onBack={() => undefined} />,
    );

    expect(html).toContain('class="studio-screen context-store-revisions"');
    expect(html).toContain('class="studio-heading revision-task-heading"');
    expect(html).toContain('class="ui-select revision-task-select"');
    expect(html).toContain('class="revision-task-empty"');
    expect(html).toContain("Back to knowledge bases");
    expect(html).toContain("All knowledge bases");
    expect(html).not.toContain("revision-task-toolbar");
    expect(html).not.toContain("New revision task");
    expect(html).not.toContain("Store Revision Agent");
  });

  it("renders the task page in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");

    const html = renderToStaticMarkup(
      <ContextStoreRevisionFragment stores={[]} onBack={() => undefined} />,
    );

    expect(html).toContain("修订任务");
    expect(html).toContain("全部知识库");
    expect(html).toContain("暂无修订任务");
  });

  it("renders review-only documents before the changed files", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(
      <ContextStoreRevisionDiffFragment
        job={{
          schemaVersion: "pragma.context-store-revision-job/v1",
          id: "10000000-0000-4000-8000-000000000001",
          revision: 3,
          request: {
            schemaVersion: "pragma.context-store-revision-request/v1",
            storeId: "00000000-0000-4000-8000-000000000001",
            prompt: "补充审批流程",
            source: "user",
          },
          state: "pending_review",
          changeSet: {
            schemaVersion: "pragma.context-store-change-set/v1",
            storeId: "00000000-0000-4000-8000-000000000001",
            baseRevision: 4,
            baseSnapshotHash: "0".repeat(64),
            summary: "更新审批规范",
            operations: [
              {
                operation: "upsert",
                id: "guide.md",
                previousContent: "# 审批\n旧流程\n",
                content: "# 审批\n新流程\n",
                metadata: { description: "审批", trigger: "manual", priority: "normal" },
              },
            ],
          },
          createdAt: "2026-08-05T07:24:00.000Z",
          updatedAt: "2026-08-05T07:29:00.000Z",
        }}
        busy={false}
        error={null}
        onBack={() => undefined}
        onApprove={() => undefined}
        onReject={() => undefined}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain("修订结果");
    expect(html).toContain("返回修订任务");
    expect(html).toContain("revision-request.md");
    expect(html).toContain("revision-summary.md");
    expect(html.indexOf("revision-summary.md")).toBeLessThan(html.indexOf("revision-request.md"));
    expect(html).toContain("不会进入 Memory");
    expect(html).toContain("更新审批规范");
    expect(html).toContain("guide.md");
    expect(html).toContain("同意并应用");
    expect(html).toContain('class="revision-diff-scroll-area"');
  });

  it("builds stable line-level additions and deletions", () => {
    expect(buildRevisionLineDiff("first\nold", "first\nnew")).toEqual([
      { kind: "context", content: "first", oldLine: 1, newLine: 1 },
      { kind: "deletion", content: "old", oldLine: 2 },
      { kind: "addition", content: "new", newLine: 2 },
    ]);
  });
});
