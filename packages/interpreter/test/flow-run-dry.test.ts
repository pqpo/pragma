import { PRAGMA_DSL_WRITE_API_VERSION } from "../src/ast/index.ts";
import { describe, expect, it } from "vitest";

import {
  PragmaFlowRunDryEvaluationResourceSchema,
  type PragmaFlowRunDryEvaluationResource,
} from "../src/ast/index.ts";

import { PragmaFlowResourceSchema, type PragmaFlowResource } from "../src/ast/index.ts";
import { runPragmaEvaluation } from "../src/index.ts";

describe("Pragma Flow Evaluation integration", () => {
  it("runs an independent Evaluation resource and covers every route", () => {
    const { flow, evaluation } = reviewFixture();
    const result = runPragmaEvaluation(flow, evaluation);

    expect(result.passed).toBe(true);
    expect(result.summary).toEqual({ total: 2, passed: 2, failed: 0 });
    expect(result.coverage.missing).toEqual([]);
    expect(result.cases[0]).toMatchObject({
      passed: true,
      status: "succeeded",
      path: ["draft", "approve", "publish"],
      output: { published: true },
    });
  });

  it("keeps Flow resources free of embedded evaluation cases", () => {
    const { flow } = reviewFixture();
    const parsed = PragmaFlowResourceSchema.safeParse({
      ...flow,
      spec: { ...flow.spec, runDry: { cases: [] } },
    });

    expect(parsed.success).toBe(false);
  });

  it("requires an Evaluation to target the supplied Flow", () => {
    const { flow, evaluation } = reviewFixture();
    const wrongTarget = {
      ...evaluation,
      spec: { ...evaluation.spec, target: { ref: "flow:9h0j1k2m3n4p5q6r" } },
    } as PragmaFlowRunDryEvaluationResource;

    expect(() => runPragmaEvaluation(flow, wrongTarget)).toThrow("targets flow:9h0j1k2m3n4p5q6r");
  });

  it("uses the original Flow input for expectInput and a separate rendered expectPrompt", () => {
    const { flow, evaluation } = reviewFixture();
    const result = runPragmaEvaluation(flow, evaluation);

    expect(result.cases[0]?.passed).toBe(true);
    expect(result.cases[0]?.error).toBeUndefined();
  });

  it("reports expected and actual input values on mismatch", () => {
    const { flow, evaluation } = reviewFixture();
    const broken = withFirstMock(evaluation, {
      expectInput: "rendered prompt",
      expectPrompt: "Draft Ship",
      output: { text: "Ready" },
    });
    const result = runPragmaEvaluation(flow, broken);

    expect(result.cases[0]).toMatchObject({
      passed: false,
      status: "failed",
      error:
        'Run dry mock expectInput does not match step draft visit 1: expected "rendered prompt", actual {"goal":"Ship"}.',
    });
  });

  it("reports expected and actual prompts on mismatch", () => {
    const { flow, evaluation } = reviewFixture();
    const broken = withFirstMock(evaluation, {
      expectInput: { goal: "Ship" },
      expectPrompt: "Draft something else",
      output: { text: "Ready" },
    });
    const result = runPragmaEvaluation(flow, broken);

    expect(result.cases[0]?.error).toBe(
      'Run dry mock expectPrompt does not match step draft visit 1: expected "Draft something else", actual "Draft Ship".',
    );
  });

  it("rejects a prompt-bearing mock that omits expectPrompt", () => {
    const { flow, evaluation } = reviewFixture();
    const broken = withFirstMock(evaluation, {
      expectInput: { goal: "Ship" },
      output: { text: "Ready" },
    });
    const result = runPragmaEvaluation(flow, broken);

    expect(result.cases[0]?.error).toBe(
      "Prompt-bearing step draft mock must declare expectPrompt for visit 1.",
    );
  });

  it("validates failed cases and required mock input at the Evaluation boundary", () => {
    const { evaluation } = reviewFixture();
    const first = evaluation.spec.method.cases[0]!;
    expect(
      PragmaFlowRunDryEvaluationResourceSchema.safeParse({
        ...evaluation,
        spec: {
          ...evaluation.spec,
          method: {
            ...evaluation.spec.method,
            cases: [{ ...first, mocks: { draft: { output: { text: "Ready" } } } }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      PragmaFlowRunDryEvaluationResourceSchema.safeParse({
        ...evaluation,
        spec: {
          ...evaluation.spec,
          method: {
            ...evaluation.spec.method,
            cases: [{ ...first, expect: { status: "failed", path: ["draft"] } }],
          },
        },
      }).success,
    ).toBe(false);
  });
});

function reviewFixture(): {
  readonly flow: PragmaFlowResource;
  readonly evaluation: PragmaFlowRunDryEvaluationResource;
} {
  const flow = PragmaFlowResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
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
            prompt: {
              segments: [
                { text: "Draft " },
                { variable: { source: "flow-input", path: ["goal"] } },
              ],
            },
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
              prompt: {
                segments: [
                  { text: "Approve " },
                  { variable: { source: "node-output", nodeId: "draft", path: ["text"] } },
                  { text: "?" },
                ],
              },
              options: [
                { value: "approve", label: "Approve" },
                { value: "reject", label: "Reject" },
              ],
            },
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
        loops: {},
        transitions: {
          draft: "approve",
          approve: {
            route: "selection",
            cases: { approve: "publish", reject: { fail: "Rejected" } },
          },
          publish: { end: true },
        },
      },
    },
  });
  const input = { goal: "Ship" };
  const evaluation = PragmaFlowRunDryEvaluationResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Evaluation",
    metadata: {
      id: "7h8j9k0m1n2p3q4r",
      name: "Review Run Dry",
      description: "Covers approval and rejection.",
      tags: ["run-dry"],
    },
    spec: {
      target: { ref: "flow:8h9j0k1m2n3p4q5r" },
      method: {
        type: "flow-run-dry",
        cases: [
          {
            id: "approve",
            name: "Approval path",
            input,
            mocks: {
              draft: {
                expectInput: input,
                expectPrompt: "Draft Ship",
                output: { text: "Ready" },
              },
              approve: {
                expectInput: input,
                expectPrompt: "Approve Ready?",
                output: { selection: "approve" },
              },
              publish: {
                expectInput: input,
                expectPrompt: "Publish",
                output: { published: true },
              },
            },
            expect: {
              status: "succeeded",
              path: ["draft", "approve", "publish"],
              output: { published: true },
            },
          },
          {
            id: "reject",
            name: "Rejection path",
            input,
            mocks: {
              draft: {
                expectInput: input,
                expectPrompt: "Draft Ship",
                output: { text: "Ready" },
              },
              approve: {
                expectInput: input,
                expectPrompt: "Approve Ready?",
                output: { selection: "reject" },
              },
            },
            expect: {
              status: "failed",
              path: ["draft", "approve"],
              errorContains: "Rejected",
            },
          },
        ],
      },
    },
  });
  return { flow, evaluation };
}

function withFirstMock(
  evaluation: PragmaFlowRunDryEvaluationResource,
  mock: Record<string, unknown>,
): PragmaFlowRunDryEvaluationResource {
  const first = evaluation.spec.method.cases[0]!;
  return PragmaFlowRunDryEvaluationResourceSchema.parse({
    ...evaluation,
    spec: {
      ...evaluation.spec,
      method: {
        ...evaluation.spec.method,
        cases: [
          { ...first, mocks: { ...first.mocks, draft: mock } },
          ...evaluation.spec.method.cases.slice(1),
        ],
      },
    },
  });
}
