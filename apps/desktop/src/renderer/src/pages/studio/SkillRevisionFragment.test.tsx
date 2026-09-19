import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import { SkillRevisionEmptyState } from "./SkillRevisionFragment.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("SkillRevisionEmptyState", () => {
  it("matches the knowledge revision empty-state structure", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(<SkillRevisionEmptyState />);

    expect(html).toContain('class="revision-task-empty"');
    expect(html).toContain("暂无能力修订");
    expect(html).toContain("已提交的候选以及等待审批的变更会显示在这里");
  });
});
