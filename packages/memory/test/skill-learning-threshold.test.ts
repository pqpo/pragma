import type { SkillSourceSnapshot } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { inspectSkillSourceEligibility, skillSourceThresholdMet } from "../src/index.ts";

function episode(
  id: string,
  conversation: string,
  outcome: SkillSourceSnapshot["outcome"] = "succeeded",
  valueScore = 0.9,
): SkillSourceSnapshot {
  return {
    ref: { kind: "episodic", id, revision: 1 },
    rootRef: { type: "pragma.expert", id: "0000000000000001" },
    conversationRef: { type: "pragma.mission", id: conversation },
    sourceExecutionIds: [`execution-${id}`],
    producerRefs: [{ type: "pragma.expert", id: "0000000000000001" }],
    title: `Episode ${id}`,
    body: "A reusable multi-step workflow was completed.",
    outcome,
    hasSuccessfulRecovery: false,
    observedAt: "2026-08-06T00:00:00.000Z",
    verified: true,
    valueScore,
    visibility: { mode: "host-private" },
    sensitivity: "internal",
  };
}

describe("Skill learning threshold", () => {
  it("reports the evidence counts and qualifying refs used by the threshold", () => {
    const eligibility = inspectSkillSourceEligibility([
      episode("one", "conversation-a"),
      episode("two", "conversation-a"),
      episode("three", "conversation-b", "failed"),
    ]);

    expect(eligibility).toEqual({
      eligible: true,
      episodeCount: 3,
      conversationCount: 2,
      succeededCount: 2,
      qualifyingSourceRefs: [
        { kind: "episodic", id: "one", revision: 1 },
        { kind: "episodic", id: "three", revision: 1 },
        { kind: "episodic", id: "two", revision: 1 },
      ],
    });
  });

  it("accepts three high-value episodes from two conversations with two successes", () => {
    expect(
      skillSourceThresholdMet([
        episode("one", "conversation-a"),
        episode("two", "conversation-a"),
        episode("three", "conversation-b", "failed"),
      ]),
    ).toBe(true);
  });

  it("admits one successfully executed workflow without requiring a high score or multiple conversations", () => {
    expect(skillSourceThresholdMet([episode("one", "conversation-a", "succeeded", 0.2)])).toBe(
      true,
    );
  });

  it("rejects failed and supporting-only sources regardless of score and repetition", () => {
    expect(
      skillSourceThresholdMet([
        episode("one", "conversation-a", "failed"),
        episode("two", "conversation-b", "failed"),
        episode("three", "conversation-c", "failed"),
      ]),
    ).toBe(false);
    expect(
      skillSourceThresholdMet([
        {
          ...episode("fact", "conversation-a"),
          ref: { kind: "semantic", id: "fact", revision: 1 },
          outcome: "supporting",
        },
      ]),
    ).toBe(false);
  });

  it("does not use a superseded successful revision when the newest Episode no longer succeeds", () => {
    expect(
      skillSourceThresholdMet([
        episode("one", "conversation-a"),
        {
          ...episode("one", "conversation-a", "failed"),
          ref: { kind: "episodic", id: "one", revision: 2 },
        },
      ]),
    ).toBe(false);
  });
});
