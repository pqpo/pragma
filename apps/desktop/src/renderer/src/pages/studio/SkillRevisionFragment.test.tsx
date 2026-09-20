import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import {
  activeSkillRevisionTaskCount,
  skillRevisionAttentionActions,
  SkillRevisionEmptyState,
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
