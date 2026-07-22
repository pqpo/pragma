import { describe, expect, it } from "vitest";

import { BUILT_IN_PRAGMA_EXPERT_REF, localizeSystemExpertCopy } from "./system-expert-copy.ts";

const localizedPragma = {
  name: "Pragma",
  description: "内置通用 Agent，可直接处理日常工作并协调专业专家。",
  scope: "使用当前 Runtime、授权工作区和可用能力完成你的工作。",
};

describe("localizeSystemExpertCopy", () => {
  it("localizes the uncustomized built-in Pragma metadata", () => {
    expect(
      localizeSystemExpertCopy(
        {
          ref: BUILT_IN_PRAGMA_EXPERT_REF,
          name: "Pragma",
          description: "Canonical description",
          scope: "Canonical scope",
          origin: "built-in",
          customized: false,
        },
        localizedPragma,
      ),
    ).toEqual(localizedPragma);
  });

  it("preserves customized built-in metadata as authored content", () => {
    expect(
      localizeSystemExpertCopy(
        {
          ref: BUILT_IN_PRAGMA_EXPERT_REF,
          name: "My Pragma",
          description: "My description",
          scope: "My scope",
          origin: "built-in",
          customized: true,
        },
        localizedPragma,
      ),
    ).toEqual({
      name: "My Pragma",
      description: "My description",
      scope: "My scope",
    });
  });

  it("preserves project Expert metadata as authored content", () => {
    expect(
      localizeSystemExpertCopy(
        {
          ref: "expert:reviewer@1.0.0",
          name: "Reviewer",
          description: "Reviews changes",
          origin: "project",
          customized: false,
        },
        localizedPragma,
      ),
    ).toEqual({ name: "Reviewer", description: "Reviews changes" });
  });
});
