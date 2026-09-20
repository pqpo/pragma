import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  activeSkillRevisionTaskCount,
  canDeleteSkillRevisionJob,
  canRetrySkillRevisionJob,
  formatSkillFileMetadata,
  filterSkillRevisionEntries,
  skillRevisionAttentionActions,
  SkillRevisionDetailFragment,
  SkillRevisionEmptyState,
  SkillRevisionTaskActions,
  type SkillRevisionEntry,
} from "./SkillRevisionFragment.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("SkillRevisionEmptyState", () => {
  it("filters skill revisions by status and actionable state", () => {
    const entries = [
      { job: { state: "pending_review" }, draft: {} },
      { job: { state: "needs_rebase" }, draft: {} },
      { job: { state: "needs_attention" }, draft: {} },
      { job: { state: "completed" }, draft: {} },
    ] as unknown as SkillRevisionEntry[];

    expect(filterSkillRevisionEntries(entries, "actionable")).toHaveLength(3);
    expect(filterSkillRevisionEntries(entries, "completed")).toHaveLength(1);
    expect(filterSkillRevisionEntries(entries, "")).toHaveLength(4);
    expect(filterSkillRevisionEntries(entries, "", "skill-a")).toHaveLength(0);
    expect(
      filterSkillRevisionEntries(
        entries.map((entry, index) => ({
          ...entry,
          draft: { capabilityId: index === 0 ? "skill-a" : "skill-b" },
        })) as unknown as SkillRevisionEntry[],
        "",
        "skill-a",
      ),
    ).toHaveLength(1);
  });

  it("counts only non-terminal revision tasks", () => {
    expect(
      activeSkillRevisionTaskCount([
        { job: { state: "running" } },
        { job: { state: "pending_review" } },
        { job: { state: "needs_rebase" } },
        { job: { state: "needs_attention" } },
        { job: { state: "completed" } },
        { job: { state: "rejected" } },
        { job: { state: "superseded" } },
      ]),
    ).toBe(4);
  });

  it("offers deletion for every revision state", () => {
    expect(
      [
        "editing",
        "running",
        "pending_review",
        "publishing",
        "completed",
        "rejected",
        "needs_rebase",
        "needs_attention",
        "superseded",
      ].filter((state) =>
        canDeleteSkillRevisionJob(state as Parameters<typeof canDeleteSkillRevisionJob>[0]),
      ),
    ).toEqual([
      "editing",
      "running",
      "pending_review",
      "publishing",
      "completed",
      "rejected",
      "needs_rebase",
      "needs_attention",
      "superseded",
    ]);
  });

  it("routes a revision whose base changed through its Mission instead of retry", () => {
    expect(canRetrySkillRevisionJob("needs_rebase", "skill_revision_base_changed")).toBe(false);
    expect(canRetrySkillRevisionJob("rejected", "skill_revision_base_changed")).toBe(false);
    expect(canRetrySkillRevisionJob("rejected", undefined)).toBe(true);
    expect(canRetrySkillRevisionJob("needs_attention", "invalid_input")).toBe(true);
  });

  it("shows executable-only file changes in review metadata", () => {
    const t = i18n.getFixedT("en", "studio");
    const metadata = formatSkillFileMetadata(
      {
        jobId: "00000000-0000-4000-8000-000000000001",
        path: "scripts/run.mjs",
        before: {
          sizeBytes: 20,
          sha256: "a".repeat(64),
          executable: false,
          content: "export const run = 1;\n",
          unavailableReason: null,
        },
        after: {
          sizeBytes: 20,
          sha256: "a".repeat(64),
          executable: true,
          content: "export const run = 1;\n",
          unavailableReason: null,
        },
      },
      t,
    );

    expect(metadata).toContain("not executable → 20 B");
    expect(metadata).toContain("executable");
  });

  it("keeps list actions icon-only like the knowledge revision list", async () => {
    await i18n.changeLanguage("zh-Hans");
    const noop = () => undefined;
    const review = renderToStaticMarkup(
      <SkillRevisionTaskActions
        jobState="pending_review"
        draftState="pending_review"
        busy={false}
        canOpenMission={false}
        onRetry={noop}
        onDelete={noop}
      />,
    );
    const terminal = renderToStaticMarkup(
      <SkillRevisionTaskActions
        jobState="rejected"
        draftState="rejected"
        busy={false}
        canOpenMission={false}
        onRetry={noop}
        onDelete={noop}
      />,
    );

    expect(review).toContain('class="revision-task-actions"');
    expect(review).not.toContain('class="primary-button"');
    expect(review).not.toContain("批准并发布");
    expect(review).not.toContain("拒绝");
    expect(terminal).toContain('aria-label="重试"');
    expect(terminal).toContain("revision-task-icon-button is-danger");
    expect(terminal).toContain('aria-label="删除任务"');
  });

  it("places approval and rejection in the revision detail header", async () => {
    await i18n.changeLanguage("zh-Hans");
    const noop = () => undefined;
    const entry = {
      job: {
        id: "00000000-0000-4000-8000-000000000001",
        revision: 2,
        state: "pending_review",
        request: { prompt: "完善 Git 冲突处理流程" },
        updatedAt: "2026-09-20T08:00:00.000Z",
      },
      draft: {
        name: "git-merge-conflict-resolver",
        operation: "create",
        state: "pending_review",
        baseRevision: 0,
        summary: "新增合并前分析与合并后验证。",
      },
    } as unknown as SkillRevisionEntry;
    const html = renderToStaticMarkup(
      <SkillRevisionDetailFragment
        entry={entry}
        busy={false}
        canOpenMission={false}
        onBack={noop}
        onApprove={noop}
        onReject={noop}
        onRetry={noop}
        onContinue={noop}
        onRebase={noop}
      />,
    );

    expect(html).toContain(
      'class="studio-screen context-store-revision-detail skill-revision-detail"',
    );
    expect(html).toContain('class="revision-diff-actions"');
    expect(html).toContain('class="revision-diff-workspace"');
    expect(html).toContain("revision-summary.md");
    expect(html).toContain("revision-request.md");
    expect(html).toContain('class="primary-button"');
    expect(html).toContain("批准并发布");
    expect(html).toContain("拒绝");
    expect(html).toContain("新增合并前分析与合并后验证。");
  });

  it("matches the knowledge revision empty-state structure", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(<SkillRevisionEmptyState />);

    expect(html).toContain('class="revision-task-empty"');
    expect(html).toContain("暂无技能修订");
    expect(html).toContain("已提交的候选以及等待审批的变更会显示在这里");
  });

  it("retries publication failures even when the job retains its Mission", () => {
    expect(
      skillRevisionAttentionActions(
        {
          job: {
            missionId: "00000000-0000-4000-8000-000000000001",
            error: { code: "skill_creation_id_conflict", message: "Conflict." },
          },
          draft: { state: "needs_attention" },
        },
        true,
      ),
    ).toEqual({ canContinue: false, canRetry: true });
  });

  it("continues an editable or validation-blocked managed Mission", () => {
    const missionId = "00000000-0000-4000-8000-000000000001";
    expect(
      skillRevisionAttentionActions({ job: { missionId }, draft: { state: "editing" } }, true),
    ).toEqual({ canContinue: true, canRetry: false });
    expect(
      skillRevisionAttentionActions({ job: { missionId }, draft: { state: "needs_rebase" } }, true),
    ).toEqual({ canContinue: true, canRetry: false });
    expect(
      skillRevisionAttentionActions(
        {
          job: {
            missionId,
            error: {
              code: "skill_revision_validation_required",
              message: "Repair the draft.",
            },
          },
          draft: { state: "needs_attention" },
        },
        true,
      ),
    ).toEqual({ canContinue: true, canRetry: false });
  });

  it("shows rebase guidance and the carried Agent prompt", async () => {
    await i18n.changeLanguage("zh-Hans");
    const noop = () => undefined;
    const entry = {
      job: {
        id: "00000000-0000-4000-8000-000000000001",
        revision: 3,
        state: "needs_rebase",
        missionId: "00000000-0000-4000-8000-000000000002",
        request: { prompt: "更新现有 Skill" },
        error: {
          code: "skill_revision_base_changed",
          message: "The formal Skill changed after this draft was created.",
        },
        updatedAt: "2026-09-20T08:00:00.000Z",
      },
      draft: {
        name: "safe-workflow",
        operation: "revise",
        state: "needs_rebase",
        baseRevision: 1,
      },
    } as unknown as SkillRevisionEntry;
    const html = renderToStaticMarkup(
      <SkillRevisionDetailFragment
        entry={entry}
        busy={false}
        canOpenMission
        onBack={noop}
        onApprove={noop}
        onReject={noop}
        onRetry={noop}
        onContinue={noop}
        onRebase={noop}
      />,
    );

    expect(html).toContain("Skill 已更新，需要先变基");
    expect(html).toContain("打开任务并变基");
    expect(html).toContain(
      "请检查最新知识库，将此草稿变基到最新版本；如有冲突，请逐项说明并和我确认处理方式，然后重新提交修订。",
    );
  });
});
