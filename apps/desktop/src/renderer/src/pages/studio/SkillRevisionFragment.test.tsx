import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  activeSkillRevisionTaskCount,
  canDeleteSkillRevisionJob,
  skillRevisionAttentionActions,
  SkillRevisionEmptyState,
  SkillRevisionTaskActions,
} from "./SkillRevisionFragment.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("SkillRevisionEmptyState", () => {
  it("counts only non-terminal revision tasks", () => {
    expect(
      activeSkillRevisionTaskCount([
        { job: { state: "running" } },
        { job: { state: "pending_review" } },
        { job: { state: "needs_attention" } },
        { job: { state: "completed" } },
        { job: { state: "rejected" } },
        { job: { state: "superseded" } },
      ]),
    ).toBe(3);
  });

  it("only offers deletion for states accepted by the revision service", () => {
    expect(
      [
        "editing",
        "running",
        "pending_review",
        "publishing",
        "completed",
        "rejected",
        "needs_attention",
        "superseded",
      ].filter((state) =>
        canDeleteSkillRevisionJob(state as Parameters<typeof canDeleteSkillRevisionJob>[0]),
      ),
    ).toEqual(["completed", "rejected", "needs_attention", "superseded"]);
  });

  it("uses the knowledge revision action styles for approval, rejection, and deletion", async () => {
    await i18n.changeLanguage("zh-Hans");
    const noop = () => undefined;
    const review = renderToStaticMarkup(
      <SkillRevisionTaskActions
        jobState="pending_review"
        draftState="pending_review"
        busy={false}
        canOpenMission={false}
        onApprove={noop}
        onReject={noop}
        onRetry={noop}
        onContinue={noop}
        onDelete={noop}
      />,
    );
    const terminal = renderToStaticMarkup(
      <SkillRevisionTaskActions
        jobState="rejected"
        draftState="rejected"
        busy={false}
        canOpenMission={false}
        onApprove={noop}
        onReject={noop}
        onRetry={noop}
        onContinue={noop}
        onDelete={noop}
      />,
    );

    expect(review).toContain('class="revision-task-actions"');
    expect(review).toContain('class="primary-button"');
    expect(review).toContain("批准并发布");
    expect(review).toContain("拒绝");
    expect(terminal).toContain('aria-label="重试"');
    expect(terminal).toContain("revision-task-icon-button is-danger");
    expect(terminal).toContain('aria-label="删除任务"');
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
});
