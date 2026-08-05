import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import { ContextStoreRevisionFragment } from "./ContextStoreRevisionFragment.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("ContextStoreRevisionFragment", () => {
  it("renders the styled task composer without page-local Agent settings", () => {
    const html = renderToStaticMarkup(<ContextStoreRevisionFragment stores={[]} />);

    expect(html).toContain('class="studio-screen context-store-revisions"');
    expect(html).toContain('class="studio-heading revision-task-heading"');
    expect(html).toContain('class="revision-task-composer"');
    expect(html).toContain('class="revision-task-empty"');
    expect(html).toContain("New revision task");
    expect(html).not.toContain("Store Revision Agent");
  });

  it("renders the task page in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");

    const html = renderToStaticMarkup(<ContextStoreRevisionFragment stores={[]} />);

    expect(html).toContain("修订任务");
    expect(html).toContain("新建修订任务");
    expect(html).toContain("暂无修订任务");
  });
});
