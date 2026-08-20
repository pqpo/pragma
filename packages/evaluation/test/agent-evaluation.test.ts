import { describe, expect, it } from "vitest";

import {
  evaluateAgentHardAssertions,
  selectAgentEvaluationCaseIds,
  summarizeAgentEvaluationTasks,
} from "../src/agent-evaluation.ts";
import {
  AgentEvaluationCaseResultSchema,
  AgentEvaluationJudgeResultSchema,
  PragmaAgentEvaluationCaseSchema,
  PragmaAgentJudgeEvaluationSpecSchema,
} from "../src/ast.ts";

const testCase = PragmaAgentEvaluationCaseSchema.parse({
  id: "customer_lookup",
  name: "Customer lookup",
  prompt: "Find C-100.",
  criteria: [{ id: "correct", description: "Answer is correct." }],
  assertions: {
    outputContains: ["active"],
    outputNotContains: ["secret"],
    tools: [{ name: "get_customer", minCalls: 1, maxCalls: 1, inputMatches: { id: "C-100" } }],
  },
  mocks: [
    {
      name: "get_customer",
      outcomes: [{ expectInput: { id: "C-100" }, output: { status: "active" } }],
    },
  ],
});

describe("Agent evaluation", () => {
  it("selects a deterministic sample without replacement", () => {
    const cases = ["a", "b", "c", "d"].map((id) => ({ ...testCase, id, name: id }));
    expect(selectAgentEvaluationCaseIds(cases, 3, "seed-1")).toEqual(
      selectAgentEvaluationCaseIds(cases, 3, "seed-1"),
    );
    expect(new Set(selectAgentEvaluationCaseIds(cases, 4, "seed-2")).size).toBe(4);
  });

  it("combines output and tool assertions", () => {
    const assertions = evaluateAgentHardAssertions({
      case: testCase,
      output: "Customer is active.",
      toolTrace: [{ name: "get_customer", status: "succeeded", input: { id: "C-100" } }],
    });
    expect(assertions).toHaveLength(4);
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it("uses resolved rate only across completed cases", () => {
    expect(
      summarizeAgentEvaluationTasks([
        { state: "resolved", result: { resolved: true } },
        { state: "unresolved", result: { resolved: false } },
        { state: "queued" },
        { state: "needs_attention" },
      ]),
    ).toEqual({
      total: 4,
      completed: 2,
      resolved: 1,
      unresolved: 1,
      needsAttention: 1,
      cancelled: 0,
      resolvedRate: 0.5,
    });
  });

  it("rejects mock fixtures in a live dataset", () => {
    expect(
      PragmaAgentJudgeEvaluationSpecSchema.safeParse({
        method: {
          type: "agent-judge",
          group: "Business understanding",
          execution: { mode: "live" },
          cases: [testCase],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid assertion ranges and duplicate case-local identifiers", () => {
    expect(
      PragmaAgentEvaluationCaseSchema.safeParse({
        ...testCase,
        criteria: [testCase.criteria[0], testCase.criteria[0]],
        assertions: {
          ...testCase.assertions,
          tools: [{ name: "get_customer", minCalls: 2, maxCalls: 1 }],
        },
        mocks: [testCase.mocks[0], testCase.mocks[0]],
      }).error?.issues.map((issue) => issue.path.join(".")),
    ).toEqual(
      expect.arrayContaining(["criteria.1.id", "assertions.tools.0.maxCalls", "mocks.1.name"]),
    );
  });

  it("rejects duplicate case IDs across an agent-judge dataset", () => {
    const resource = {
      method: {
        type: "agent-judge",
        group: "Tool calling",
        execution: { mode: "mock" },
        cases: [testCase, testCase],
      },
    } as const;

    expect(
      PragmaAgentJudgeEvaluationSpecSchema.safeParse(resource).error?.issues.map((issue) =>
        issue.path.join("."),
      ),
    ).toContain("method.cases.1.id");
  });

  it("rejects a Judge resolved state that contradicts its criteria", () => {
    expect(
      AgentEvaluationJudgeResultSchema.safeParse({
        schemaVersion: "pragma.evaluation-judge-result/v1",
        resolved: true,
        criteria: [{ id: "correct", passed: false, score: 0, evidence: "Incorrect." }],
        summary: "Unresolved.",
      }).success,
    ).toBe(false);
  });

  it("rejects a case resolved state that contradicts hard assertions", () => {
    expect(
      AgentEvaluationCaseResultSchema.safeParse({
        caseId: "lookup",
        output: "Customer is active.",
        toolTrace: [],
        assertions: [{ kind: "output_contains", passed: false, message: "Missing value." }],
        judge: {
          schemaVersion: "pragma.evaluation-judge-result/v1",
          resolved: true,
          criteria: [{ id: "correct", passed: true, score: 100, evidence: "Correct." }],
          summary: "Resolved.",
        },
        resolved: true,
      }).success,
    ).toBe(false);
  });
});
