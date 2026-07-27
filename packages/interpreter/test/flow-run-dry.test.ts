import { describe, expect, it } from "vitest";

import { PragmaFlowResourceSchema, type PragmaFlowResource } from "../src/ast/index.ts";
import { runPragmaFlowDrySuite } from "../src/index.ts";

describe("Pragma Flow run dry", () => {
  it("mocks expert and Human Task outputs while covering every route", () => {
    const result = runPragmaFlowDrySuite(reviewFlow());

    expect(result.passed).toBe(true);
    expect(result.summary).toEqual({ total: 3, passed: 3, failed: 0 });
    expect(result.coverage.missing).toEqual([]);
    expect(result.coverage.required).toContain("approve:case:approve");
    expect(result.coverage.required).toContain("approve:case:revise");
    expect(result.coverage.required).toContain("loop:refinement:repeat");
    expect(result.coverage.required).toContain("loop:refinement:limit");
    expect(result.cases[0]).toMatchObject({
      passed: true,
      status: "succeeded",
      path: ["draft", "approve", "publish"],
      output: { published: true },
    });
  });

  it("fails a case when a repeated node has no mock for the next visit", () => {
    const flow = reviewFlow();
    flow.spec.runDry = {
      cases: [
        {
          id: "missing-repeat",
          name: "Missing repeat mock",
          input: { goal: "Ship" },
          mocks: {
            draft: { expectInput: "Draft", output: { text: "v1" } },
            approve: {
              expectInput: { goal: "Ship" },
              expectPrompt: "Approve?",
              output: { selection: "revise" },
            },
            revise: { expectInput: "Revise", output: { text: "v2" } },
          },
          expect: {
            status: "succeeded",
            path: ["draft", "approve", "revise", "draft"],
          },
        },
      ],
    };

    const result = runPragmaFlowDrySuite(flow);

    expect(result.passed).toBe(false);
    expect(result.cases[0]).toMatchObject({
      passed: false,
      status: "failed",
      path: ["draft", "approve", "revise", "draft"],
      error: "Run dry mock is missing for step draft visit 2.",
      assertions: expect.arrayContaining([
        expect.objectContaining({ kind: "configuration", passed: false }),
      ]),
    });
  });

  it("reports uncovered transitions even when every configured assertion passes", () => {
    const flow = reviewFlow();
    flow.spec.runDry = { cases: [flow.spec.runDry!.cases[0]!] };

    const result = runPragmaFlowDrySuite(flow);

    expect(result.cases[0]?.passed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.coverage.missing).toContain("approve:case:revise");
  });

  it("uses Core transition selection for every array-route operator and fallback", () => {
    const result = runPragmaFlowDrySuite(arrayRouteFlow());

    expect(result.passed).toBe(true);
    expect(result.coverage.required).toEqual([
      "decide:branch:all",
      "decide:branch:any",
      "decide:branch:none",
      "decide:fallback",
      "finish_all:next",
      "finish_any:next",
      "finish_fallback:next",
      "finish_none:next",
    ]);
    expect(result.coverage.covered).toEqual(result.coverage.required);
  });

  it("supports an empty path for an expected Flow input validation failure", () => {
    const flow = reviewFlow();
    flow.spec.runDry = {
      cases: [
        {
          id: "invalid-input",
          name: "Reject invalid input",
          input: {},
          mocks: {},
          expect: {
            status: "failed",
            path: [],
            errorContains: "Flow input is invalid",
          },
        },
        ...flow.spec.runDry!.cases,
      ],
    };

    const result = runPragmaFlowDrySuite(flow);

    expect(result.cases[0]).toMatchObject({
      passed: true,
      status: "failed",
      path: [],
    });
  });

  it("rejects mocks without expected inputs and failed cases without an error assertion", () => {
    const flow = reviewFlow();
    const testCase = flow.spec.runDry!.cases[0]!;

    expect(
      PragmaFlowResourceSchema.safeParse({
        ...flow,
        spec: {
          ...flow.spec,
          runDry: {
            cases: [
              {
                ...testCase,
                mocks: { draft: { output: { text: "Ready" } } },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      PragmaFlowResourceSchema.safeParse({
        ...flow,
        spec: {
          ...flow.spec,
          runDry: {
            cases: [
              {
                ...testCase,
                expect: { status: "failed", path: ["draft"] },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });
});

function reviewFlow(): PragmaFlowResource {
  return PragmaFlowResourceSchema.parse({
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "8h9j0k1m2n3p4q5r",
      name: "Review",
      description: "Draft, review, and publish.",
      tags: [],
    },
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
          properties: { published: { type: "boolean" } },
          required: ["published"],
          additionalProperties: false,
        },
      },
      graph: {
        start: "draft",
        steps: {
          draft: {
            expert: { ref: "expert:6h7j8k9m0n1p2q3r" },
            prompt: { segments: [{ text: "Draft" }] },
            output: {
              schema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
                additionalProperties: false,
              },
            },
          },
          approve: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Approve?" }] },
              options: [
                { value: "approve", label: "Approve" },
                { value: "revise", label: "Revise" },
              ],
            },
          },
          revise: {
            expert: { ref: "expert:6h7j8k9m0n1p2q3r" },
            prompt: { segments: [{ text: "Revise" }] },
          },
          publish: {
            expert: { ref: "expert:6h7j8k9m0n1p2q3r" },
            prompt: { segments: [{ text: "Publish" }] },
            output: {
              schema: {
                type: "object",
                properties: { published: { type: "boolean" } },
                required: ["published"],
                additionalProperties: false,
              },
            },
          },
        },
        loops: {
          refinement: {
            entry: "draft",
            maxIterations: 2,
            onLimit: { fail: "Review limit reached" },
          },
        },
        transitions: {
          draft: "approve",
          approve: {
            route: "selection",
            cases: {
              approve: "publish",
              revise: "revise",
            },
          },
          revise: { repeat: { loop: "refinement", goto: "draft" } },
          publish: { end: true },
        },
      },
      runDry: {
        cases: [
          {
            id: "approve",
            name: "Approval path",
            input: { goal: "Ship" },
            mocks: {
              draft: { expectInput: "Draft", output: { text: "Ready" } },
              approve: {
                expectInput: { goal: "Ship" },
                expectPrompt: "Approve?",
                output: { selection: "approve" },
              },
              publish: { expectInput: "Publish", output: { published: true } },
            },
            expect: {
              status: "succeeded",
              path: ["draft", "approve", "publish"],
              output: { published: true },
            },
          },
          {
            id: "revise",
            name: "Revision path",
            input: { goal: "Ship" },
            mocks: {
              draft: [
                { expectInput: "Draft", output: { text: "v1" } },
                { expectInput: "Draft", output: { text: "v2" } },
              ],
              approve: [
                {
                  expectInput: { goal: "Ship" },
                  expectPrompt: "Approve?",
                  output: { selection: "revise" },
                },
                {
                  expectInput: { goal: "Ship" },
                  expectPrompt: "Approve?",
                  output: { selection: "approve" },
                },
              ],
              revise: { expectInput: "Revise", output: { text: "v2" } },
              publish: { expectInput: "Publish", output: { published: true } },
            },
            expect: {
              status: "succeeded",
              path: ["draft", "approve", "revise", "draft", "approve", "publish"],
              output: { published: true },
            },
          },
          {
            id: "limit",
            name: "Revision limit",
            input: { goal: "Ship" },
            mocks: {
              draft: [
                { expectInput: "Draft", output: { text: "v1" } },
                { expectInput: "Draft", output: { text: "v2" } },
              ],
              approve: [
                {
                  expectInput: { goal: "Ship" },
                  expectPrompt: "Approve?",
                  output: { selection: "revise" },
                },
                {
                  expectInput: { goal: "Ship" },
                  expectPrompt: "Approve?",
                  output: { selection: "revise" },
                },
              ],
              revise: [
                { expectInput: "Revise", output: { text: "v2" } },
                { expectInput: "Revise", output: { text: "v3" } },
              ],
            },
            expect: {
              status: "failed",
              path: ["draft", "approve", "revise", "draft", "approve", "revise"],
              errorContains: "Review limit reached",
            },
          },
        ],
      },
    },
  });
}

function arrayRouteFlow(): PragmaFlowResource {
  const choices = [
    { id: "all", values: ["a", "b"], destination: "finish_all" },
    { id: "any", values: ["c"], destination: "finish_any" },
    { id: "none", values: ["d"], destination: "finish_none" },
  ] as const;
  const cases = [
    { id: "all", values: ["a", "b"], finish: "finish_all" },
    { id: "any", values: ["c"], finish: "finish_any" },
    { id: "none", values: ["x"], finish: "finish_none" },
    { id: "fallback", values: ["d"], finish: "finish_fallback" },
  ] as const;
  return PragmaFlowResourceSchema.parse({
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "9h0j1k2m3n4p5q6r",
      name: "Array route",
      description: "Exercises array route operators.",
      tags: [],
    },
    spec: {
      graph: {
        start: "decide",
        steps: Object.fromEntries(
          ["decide", "finish_all", "finish_any", "finish_none", "finish_fallback"].map((id) => [
            id,
            {
              expert: { ref: "expert:6h7j8k9m0n1p2q3r" },
              prompt: { segments: [{ text: id }] },
            },
          ]),
        ),
        loops: {},
        transitions: {
          decide: {
            route: "values",
            branches: choices.map((choice) => ({
              ...choice,
              operator:
                choice.id === "all"
                  ? "contains_all"
                  : choice.id === "any"
                    ? "contains_any"
                    : "contains_none",
            })),
            fallback: "finish_fallback",
          },
          finish_all: { end: true },
          finish_any: { end: true },
          finish_none: { end: true },
          finish_fallback: { end: true },
        },
      },
      runDry: {
        cases: cases.map((testCase) => ({
          id: testCase.id,
          name: testCase.id,
          input: {},
          mocks: {
            decide: {
              expectInput: "decide",
              output: { values: testCase.values },
            },
            [testCase.finish]: {
              expectInput: testCase.finish,
              output: { result: testCase.id },
            },
          },
          expect: {
            status: "succeeded",
            path: ["decide", testCase.finish],
            output: { result: testCase.id },
          },
        })),
      },
    },
  });
}
