import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../i18n/index.ts";
import { localizedContextStoreRevisionError } from "./context-store-revision-errors.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("localizedContextStoreRevisionError", () => {
  it("turns a missing revision model into actionable Simplified Chinese copy", async () => {
    await i18n.changeLanguage("zh-Hans");

    const message = localizedContextStoreRevisionError(
      {
        code: "generation_failed",
        message:
          "The built-in runtime has no configured model. Configure a Model Provider or choose an explicit model for this mission.",
      },
      (key, options) => i18n.t(key, { ns: "studio", ...options }),
    );

    expect(message).toBe("未配置修订模型，请在“设置 → 模型与供应商”中完成配置后重试。");
    expect(message).not.toContain("The built-in runtime");
    expect(message).not.toContain("generation_failed");
  });

  it("does not expose an unknown backend message in the user-facing fallback", () => {
    const message = localizedContextStoreRevisionError(
      { code: "generation_failed", message: "internal-only diagnostic" },
      (key, options) => i18n.t(key, { ns: "studio", ...options }),
    );

    expect(message).toBe(
      "Revision generation did not finish. Open the related task to inspect the run details, then retry.",
    );
    expect(message).not.toContain("internal-only diagnostic");
  });

  it("explains that an unsubmitted draft is still editable", async () => {
    await i18n.changeLanguage("zh-Hans");

    const message = localizedContextStoreRevisionError(
      {
        code: "draft_not_submitted",
        message: "The Store Revision Agent finished without submitting its draft.",
      },
      (key, options) => i18n.t(key, { ns: "studio", ...options }),
    );

    expect(message).toBe(
      "草稿仍可编辑，尚未提交审批。请先查看变更，确认后打开关联任务继续修改或提交。",
    );
  });
});
