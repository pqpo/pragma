import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  buildRevisionLineDiff,
  ContextStoreRevisionDiffFragment,
  ContextStoreRevisionFragment,
  draftOverlayOperations,
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
          schemaVersion: "pragma.context-store-revision-job/v2",
          id: "10000000-0000-4000-8000-000000000001",
          revision: 3,
          draftId: "20000000-0000-4000-8000-000000000001",
          request: {
            schemaVersion: "pragma.context-store-revision-request/v1",
            storeId: "00000000-0000-4000-8000-000000000001",
            prompt: "补充审批流程",
            source: "user",
          },
          state: "pending_review",
          createdAt: "2026-08-05T07:24:00.000Z",
          updatedAt: "2026-08-05T07:29:00.000Z",
        }}
        draft={{
          schemaVersion: "pragma.context-store-draft/v1",
          id: "20000000-0000-4000-8000-000000000001",
          revision: 2,
          name: "审批流程修订",
          storeId: "00000000-0000-4000-8000-000000000001",
          baseRevision: 4,
          baseSnapshotHash: "0".repeat(64),
          state: "pending_review",
          submittedRevision: 2,
          summary: "更新审批规范",
          overlay: {
            files: [
              {
                id: "guide.md",
                content: "# 审批\n新流程\n",
                metadata: { description: "审批", trigger: "manual", priority: "normal" },
              },
            ],
            deletedFiles: [],
            directories: [],
            deletedDirectories: [],
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
    expect(html).not.toContain("revision-draft-editor");
    expect(html).not.toContain("保存草稿文件");
  });

  it("shows a clear path for continuing a stale draft", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(
      <ContextStoreRevisionDiffFragment
        job={{
          schemaVersion: "pragma.context-store-revision-job/v2",
          id: "10000000-0000-4000-8000-000000000002",
          revision: 4,
          draftId: "20000000-0000-4000-8000-000000000002",
          missionId: "30000000-0000-4000-8000-000000000002",
          request: {
            schemaVersion: "pragma.context-store-revision-request/v1",
            storeId: "00000000-0000-4000-8000-000000000002",
            prompt: "同步最新知识库",
            source: "user",
          },
          state: "needs_rebase",
          createdAt: "2026-08-05T07:24:00.000Z",
          updatedAt: "2026-08-05T07:29:00.000Z",
        }}
        draft={{
          schemaVersion: "pragma.context-store-draft/v1",
          id: "20000000-0000-4000-8000-000000000002",
          revision: 3,
          name: "同步最新知识库",
          storeId: "00000000-0000-4000-8000-000000000002",
          baseRevision: 4,
          baseSnapshotHash: "0".repeat(64),
          state: "needs_rebase",
          overlay: {
            files: [],
            deletedFiles: [],
            directories: [],
            deletedDirectories: [],
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
        onOpenMission={() => undefined}
      />,
    );

    expect(html).toContain("知识库已更新，需要先变基");
    expect(html).toContain("打开任务并变基");
    expect(html).toContain("请检查最新知识库");
    expect(html).toContain("工作室 → 知识库 → 修订任务");
  });

  it("builds stable line-level additions and deletions", () => {
    expect(buildRevisionLineDiff("first\nold", "first\nnew")).toEqual([
      { kind: "context", content: "first", oldLine: 1, newLine: 1 },
      { kind: "deletion", content: "old", oldLine: 2 },
      { kind: "addition", content: "new", newLine: 2 },
    ]);
  });

  it("uses fixed baseline content when reviewing an updated draft file", () => {
    const draft = {
      schemaVersion: "pragma.context-store-draft/v1" as const,
      id: "20000000-0000-4000-8000-000000000003",
      revision: 2,
      name: "Update guide",
      storeId: "00000000-0000-4000-8000-000000000003",
      baseRevision: 4,
      baseSnapshotHash: "0".repeat(64),
      state: "pending_review" as const,
      submittedRevision: 2,
      overlay: {
        files: [
          {
            id: "guide.md",
            content: "first\nnew",
            metadata: { trigger: "manual" as const, priority: "normal" as const },
          },
        ],
        deletedFiles: [],
        directories: [],
        deletedDirectories: [],
      },
      createdAt: "2026-08-05T07:24:00.000Z",
      updatedAt: "2026-08-05T07:29:00.000Z",
    };
    const [operation] = draftOverlayOperations(draft, {
      schemaVersion: "pragma.context-store-change-set/v1",
      storeId: draft.storeId,
      baseRevision: draft.baseRevision,
      baseSnapshotHash: draft.baseSnapshotHash,
      summary: "Update guide",
      operations: [
        {
          operation: "upsert",
          id: "guide.md",
          previousContent: "first\nold",
          content: "first\nnew",
          metadata: { trigger: "manual", priority: "normal" },
        },
      ],
    });

    expect(operation).toMatchObject({
      operation: "upsert",
      previousContent: "first\nold",
      content: "first\nnew",
    });
    if (operation?.operation !== "upsert") throw new Error("Expected an upsert operation.");
    const diff = buildRevisionLineDiff(operation.previousContent ?? "", operation.content);
    expect(diff.filter((line) => line.kind === "addition")).toHaveLength(1);
    expect(diff.filter((line) => line.kind === "deletion")).toHaveLength(1);
  });
});
