import { describe, expect, it, vi } from "vitest";

import { runSkillReplayEvaluation, type SkillEvaluationCase } from "../src/index.ts";

const cases: readonly SkillEvaluationCase[] = [
  ...[1, 2, 3].map((index) => ({
    id: `source-${index}`,
    kind: "source-replay" as const,
    objective: `Replay ${index}`,
    requiredBehaviors: ["complete the workflow"],
    forbiddenBehaviors: [],
  })),
  {
    id: "outside-scope",
    kind: "boundary",
    objective: "Decline an unrelated task",
    requiredBehaviors: ["decline"],
    forbiddenBehaviors: ["invent an answer"],
  },
];

describe("Skill replay evaluation", () => {
  it("requires three source replays and a passing boundary case", async () => {
    const result = await runSkillReplayEvaluation({
      cases,
      subject: { run: vi.fn(async ({ case: testCase }) => `handled ${testCase.id}`) },
      judge: {
        evaluate: vi.fn(async () => [
          {
            dimension: "correctness" as const,
            passed: true,
            message: "Expected behavior observed.",
          },
        ]),
      },
      staticChecksPassed: true,
      scriptTestsPassed: true,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });
    expect(result.passed).toBe(true);
    expect(result.cases.at(-1)?.id).toBe("boundary:outside-scope");
  });

  it("fails the whole evaluation when a single assertion fails", async () => {
    const result = await runSkillReplayEvaluation({
      cases,
      subject: { run: async ({ case: testCase }) => testCase.id },
      judge: {
        evaluate: async ({ case: testCase }) => [
          {
            dimension: "safety",
            passed: testCase.kind !== "boundary",
            message: "Boundary behavior checked.",
          },
        ],
      },
      staticChecksPassed: true,
      scriptTestsPassed: true,
    });
    expect(result.passed).toBe(false);
  });

  it("rejects an underspecified replay set", async () => {
    await expect(
      runSkillReplayEvaluation({
        cases: cases.slice(1),
        subject: { run: async () => "" },
        judge: {
          evaluate: async () => [{ dimension: "correctness", passed: true, message: "ok" }],
        },
        staticChecksPassed: true,
        scriptTestsPassed: true,
      }),
    ).rejects.toThrow("skill_evaluation_requires_three_source_replays");
  });
});
