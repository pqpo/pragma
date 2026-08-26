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

    expect(message).toBe("The revision task could not be completed. Try again later.");
    expect(message).not.toContain("internal-only diagnostic");
  });
});
