import { describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { deletePragmaResourceErrorMessage } from "./resource-delete-error.ts";

describe("Expert deletion errors", () => {
  it.each([
    ["en", "Expert Team “Release team”", "Expert “Reviewer”", "Flow “Release flow”"],
    ["zh-Hans", "专家团队“Release team”", "专家“Reviewer”", "流程“Release flow”"],
    ["zh-Hant", "專家團隊「Release team」", "專家「Reviewer」", "流程「Release flow」"],
  ] as const)("lists every reference with localized types in %s", (locale, team, expert, flow) => {
    const message = deletePragmaResourceErrorMessage(
      {
        code: "expert_referenced",
        message: "Raw backend error",
        referencedBy: [
          { ref: "team:0000000000000001", name: "Release team" },
          { ref: "expert:0000000000000002", name: "Reviewer" },
          { ref: "flow:0000000000000003", name: "Release flow" },
        ],
      },
      i18n.getFixedT(locale, "studio"),
    );
    expect(message).toContain(team);
    expect(message).toContain(expert);
    expect(message).toContain(flow);
    expect(message).not.toContain("Raw backend error");
  });

  it("localizes Expert reference errors without details", () => {
    expect(
      deletePragmaResourceErrorMessage(
        { code: "expert_referenced", message: "Raw backend error" },
        i18n.getFixedT("zh-Hans", "studio"),
      ),
    ).toBe("该资源仍被其他资源引用，无法删除。请先移除相关依赖关系。");
  });

  it("preserves unrelated errors", () => {
    expect(
      deletePragmaResourceErrorMessage(
        new Error("Connection lost"),
        i18n.getFixedT("en", "studio"),
      ),
    ).toBe("Connection lost");
  });
});
