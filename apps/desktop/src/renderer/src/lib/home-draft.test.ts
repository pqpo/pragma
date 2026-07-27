import { describe, expect, it, vi } from "vitest";

import { readHomeDraft, writeHomeDraft } from "./home-draft.ts";

describe("home draft persistence", () => {
  const draft = {
    executorRef: "expert:3sfd30h5017wd17d",
    workspaceOverride: { path: "/workspace/repo", basename: "repo" },
    goal: "Review this repository.",
    flowInput: { issueId: "36" },
    toolPermissionMode: "request-approval" as const,
    modelOverride: {
      providerId: "openai",
      modelId: "gpt",
      thinkingLevel: "high",
    },
  };

  it("round-trips the complete Home draft", () => {
    const setItem = vi.fn();
    writeHomeDraft({ setItem }, draft);
    const serialized = setItem.mock.calls[0]?.[1] as string;

    expect(readHomeDraft({ getItem: () => serialized })).toEqual(draft);
  });

  it("ignores malformed or unavailable storage", () => {
    expect(readHomeDraft({ getItem: () => "{bad-json" })).toBeUndefined();
    expect(readHomeDraft({ getItem: () => JSON.stringify({ executorRef: "" }) })).toBeUndefined();
    expect(
      readHomeDraft({
        getItem: () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeUndefined();
    expect(() =>
      writeHomeDraft(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        draft,
      ),
    ).not.toThrow();
  });
});
