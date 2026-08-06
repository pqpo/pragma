import type { SkillSourceSnapshot } from "@pragma/shared";
import { describe, expect, it } from "vitest";

import { skillSourceThresholdMet } from "../src/index.ts";

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
  it("accepts three high-value episodes from two conversations with two successes", () => {
    expect(
      skillSourceThresholdMet([
        episode("one", "conversation-a"),
        episode("two", "conversation-a"),
        episode("three", "conversation-b", "failed"),
      ]),
    ).toBe(true);
  });

  it("rejects fragments from one conversation or below the high-value cutoff", () => {
    expect(
      skillSourceThresholdMet([
        episode("one", "conversation-a"),
        episode("two", "conversation-a"),
        episode("three", "conversation-a"),
      ]),
    ).toBe(false);
    expect(
      skillSourceThresholdMet([
        episode("one", "conversation-a"),
        episode("two", "conversation-b"),
        episode("three", "conversation-b", "succeeded", 0.84),
      ]),
    ).toBe(false);
  });

  it("uses the newest revision of an episode before applying the threshold", () => {
    expect(
      skillSourceThresholdMet([
        { ...episode("one", "conversation-a"), ref: { kind: "episodic", id: "one", revision: 1 } },
        { ...episode("two", "conversation-a"), ref: { kind: "episodic", id: "two", revision: 1 } },
        {
          ...episode("three", "conversation-b"),
          ref: { kind: "episodic", id: "three", revision: 1 },
        },
        {
          ...episode("three", "conversation-b", "failed", 0.7),
          ref: { kind: "episodic", id: "three", revision: 2 },
        },
      ]),
    ).toBe(false);
  });
});
