import { describe, expect, it } from "vitest";

import {
  PragmaFlowRunDryCaseSchema,
  PragmaFlowRunDrySuiteSchema,
  runFlowRunDryEvaluation,
  type FlowRunDryRuntime,
  type FlowRunDrySubject,
} from "../src/index.ts";

const runtime: FlowRunDryRuntime = {
  analyzeGraph: () => ({ issues: [], loopMembers: new Map() }),
  evaluateValue: (value) => value,
  renderPrompt: (prompt, _state, input) =>
    prompt.segments
      .map((segment) =>
        "text" in segment
          ? segment.text
          : String(
              segment.variable.source === "flow-input" &&
                typeof input === "object" &&
                input !== null
                ? (input as Record<string, unknown>)[segment.variable.path[0]!]
                : "",
            ),
      )
      .join(""),
};

describe("@pragma/evaluation Flow Run Dry", () => {
  it("executes through the package boundary without importing Interpreter", () => {
    const input = { goal: "Ship" };
    const result = runFlowRunDryEvaluation(
      subject(),
      PragmaFlowRunDrySuiteSchema.parse({
        cases: [
          {
            id: "ship",
            name: "Ship",
            input,
            mocks: {
              finish: {
                expectInput: input,
                expectPrompt: "Finish Ship",
                output: { ok: true },
              },
            },
            expect: {
              status: "succeeded",
              path: ["finish"],
              output: { ok: true },
            },
          },
        ],
      }),
      runtime,
    );

    expect(result).toMatchObject({
      passed: true,
      summary: { total: 1, passed: 1, failed: 0 },
      coverage: { missing: [] },
    });
  });

  it("shows structural expected and actual inputs in configuration failures", () => {
    const result = runFlowRunDryEvaluation(
      subject(),
      PragmaFlowRunDrySuiteSchema.parse({
        cases: [
          {
            id: "mismatch",
            name: "Mismatch",
            input: { goal: "Ship" },
            mocks: {
              finish: {
                expectInput: { goal: "Release" },
                expectPrompt: "Finish Ship",
                output: { ok: true },
              },
            },
            expect: { status: "succeeded", path: ["finish"] },
          },
        ],
      }),
      runtime,
    );

    expect(result.cases[0]?.error).toContain('expected {"goal":"Release"}, actual {"goal":"Ship"}');
  });

  it("requires at least one independently versioned case", () => {
    expect(PragmaFlowRunDrySuiteSchema.safeParse({ cases: [] }).success).toBe(false);
  });

  it("validates mock keys and expected paths as Flow node IDs", () => {
    const parsed = PragmaFlowRunDryCaseSchema.safeParse({
      id: "valid_case",
      name: "Reserved node",
      input: {},
      mocks: {
        constructor: {
          expectInput: {},
          output: {},
        },
      },
      expect: {
        status: "succeeded",
        path: ["constructor"],
      },
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toEqual([
      "Flow node IDs cannot use reserved names.",
      "Flow node IDs cannot use reserved names.",
    ]);
  });

  it("covers route cases, repeat sequences, loop exit, and loop limit", () => {
    const flow: FlowRunDrySubject = {
      metadata: { id: "8h9j0k1m2n3p4q5r" },
      spec: {
        limits: { maxNodeVisits: 10 },
        graph: {
          start: "check",
          steps: { check: {} },
          loops: {
            retry: {
              entry: "check",
              maxIterations: 2,
              onLimit: { fail: "Retry limit reached" },
            },
          },
          transitions: {
            check: {
              route: "continue",
              cases: {
                yes: { repeat: { loop: "retry", goto: "check" } },
                no: { end: true },
              },
            },
          },
        },
      },
    };
    const loopRuntime: FlowRunDryRuntime = {
      ...runtime,
      analyzeGraph: () => ({
        issues: [],
        loopMembers: new Map([["retry", new Set(["check"])]]),
      }),
    };
    const input = { request: "retry" };
    const result = runFlowRunDryEvaluation(
      flow,
      PragmaFlowRunDrySuiteSchema.parse({
        cases: [
          {
            id: "exit",
            name: "Exit after retry",
            input,
            mocks: {
              check: [
                { expectInput: input, output: { continue: "yes" } },
                { expectInput: input, output: { continue: "no" } },
              ],
            },
            expect: {
              status: "succeeded",
              path: ["check", "check"],
              output: { continue: "no" },
            },
          },
          {
            id: "limit",
            name: "Reach retry limit",
            input,
            mocks: {
              check: [
                { expectInput: input, output: { continue: "yes" } },
                { expectInput: input, output: { continue: "yes" } },
              ],
            },
            expect: {
              status: "failed",
              path: ["check", "check"],
              errorContains: "Retry limit reached",
            },
          },
        ],
      }),
      loopRuntime,
    );

    expect(result.passed).toBe(true);
    expect(result.coverage.missing).toEqual([]);
    expect(result.coverage.covered).toEqual(
      expect.arrayContaining([
        "check:case:no",
        "check:case:yes",
        "loop:retry:limit",
        "loop:retry:repeat",
      ]),
    );
  });

  it("covers array branches, fallback, and chained steps", () => {
    const flow: FlowRunDrySubject = {
      metadata: { id: "8h9j0k1m2n3p4q5r" },
      spec: {
        limits: { maxNodeVisits: 10 },
        graph: {
          start: "classify",
          steps: { classify: {}, secure: {}, general: {} },
          loops: {},
          transitions: {
            classify: {
              route: "labels",
              branches: [
                {
                  id: "security",
                  operator: "contains_any",
                  values: ["security"],
                  destination: "secure",
                },
              ],
              fallback: "general",
            },
            secure: { end: true },
            general: { end: true },
          },
        },
      },
    };
    const result = runFlowRunDryEvaluation(
      flow,
      PragmaFlowRunDrySuiteSchema.parse({
        cases: [
          {
            id: "secure",
            name: "Security branch",
            input: {},
            mocks: {
              classify: { expectInput: {}, output: { labels: ["security"] } },
              secure: { expectInput: {}, output: { queue: "secure" } },
            },
            expect: {
              status: "succeeded",
              path: ["classify", "secure"],
              output: { queue: "secure" },
            },
          },
          {
            id: "general",
            name: "Fallback branch",
            input: {},
            mocks: {
              classify: { expectInput: {}, output: { labels: ["docs"] } },
              general: { expectInput: {}, output: { queue: "general" } },
            },
            expect: {
              status: "succeeded",
              path: ["classify", "general"],
              output: { queue: "general" },
            },
          },
        ],
      }),
      runtime,
    );

    expect(result.passed).toBe(true);
    expect(result.coverage.missing).toEqual([]);
  });

  it("validates input, output, and Human selections while preserving expected failures", () => {
    const flow: FlowRunDrySubject = {
      metadata: { id: "8h9j0k1m2n3p4q5r" },
      spec: {
        input: {
          schema: {
            type: "object",
            properties: { goal: { type: "string" } },
            required: ["goal"],
            additionalProperties: false,
          },
        },
        output: {
          schema: {
            type: "object",
            properties: { selection: { type: "string" } },
            required: ["selection"],
            additionalProperties: false,
          },
        },
        limits: { maxNodeVisits: 10 },
        graph: {
          start: "approve",
          steps: {
            approve: {
              human: {
                selectionMode: "single",
                prompt: {
                  segments: [
                    { text: "Approve " },
                    { variable: { source: "flow-input", path: ["goal"] } },
                    { text: "?" },
                  ],
                },
                options: [{ value: "yes" }, { value: "no" }],
              },
            },
          },
          loops: {},
          transitions: { approve: { end: true } },
        },
      },
    };
    const validInput = { goal: "Ship" };
    const result = runFlowRunDryEvaluation(
      flow,
      PragmaFlowRunDrySuiteSchema.parse({
        cases: [
          {
            id: "approve",
            name: "Valid Human selection",
            input: validInput,
            mocks: {
              approve: {
                expectInput: validInput,
                expectPrompt: "Approve Ship?",
                output: { selection: "yes" },
              },
            },
            expect: {
              status: "succeeded",
              path: ["approve"],
              output: { selection: "yes" },
            },
          },
          {
            id: "invalid_input",
            name: "Invalid input",
            input: { goal: 42 },
            mocks: {},
            expect: {
              status: "failed",
              path: [],
              errorContains: "Flow input is invalid",
            },
          },
          {
            id: "invalid_selection",
            name: "Unknown Human option",
            input: validInput,
            mocks: {
              approve: {
                expectInput: validInput,
                expectPrompt: "Approve Ship?",
                output: { selection: "later" },
              },
            },
            expect: {
              status: "failed",
              path: ["approve"],
              errorContains: "selected an unknown option",
            },
          },
        ],
      }),
      runtime,
    );

    expect(result.passed).toBe(true);
    expect(result.cases.every((testCase) => testCase.passed)).toBe(true);
  });

  it("rejects duplicate case IDs", () => {
    const repeated = {
      id: "duplicate",
      name: "Duplicate",
      input: {},
      mocks: {
        finish: {
          expectInput: {},
          expectPrompt: "Finish undefined",
          output: {},
        },
      },
      expect: { status: "succeeded", path: ["finish"] },
    };

    expect(PragmaFlowRunDrySuiteSchema.safeParse({ cases: [repeated, repeated] }).success).toBe(
      false,
    );
  });
});

function subject(): FlowRunDrySubject {
  return {
    metadata: { id: "8h9j0k1m2n3p4q5r" },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "finish",
        steps: {
          finish: {
            expert: { ref: "expert:6h7j8k9m0n1p2q3r" },
            prompt: {
              segments: [
                { text: "Finish " },
                { variable: { source: "flow-input", path: ["goal"] } },
              ],
            },
          },
        },
        loops: {},
        transitions: { finish: { end: true } },
      },
    },
  };
}
