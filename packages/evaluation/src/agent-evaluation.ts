import { createHash } from "node:crypto";
import { z } from "zod";

import {
  AgentEvaluationCaseResultSchema,
  AgentEvaluationHardAssertionSchema,
  AgentEvaluationJudgeResultSchema,
  AgentEvaluationSummarySchema,
  AgentEvaluationToolTraceSchema,
  PragmaAgentEvaluationCaseSchema,
  type PragmaAgentEvaluationCase,
} from "./ast.ts";

export {
  AgentEvaluationCaseResultSchema,
  AgentEvaluationHardAssertionSchema,
  AgentEvaluationJudgeResultSchema,
  AgentEvaluationSummarySchema,
  AgentEvaluationToolTraceSchema,
};

export interface EvaluationDatasetImportAdapter {
  readonly id: string;
  readonly displayName: string;
  detect(source: string, fileName?: string): boolean;
  convert(source: string): Promise<unknown> | unknown;
}

export function selectAgentEvaluationCaseIds(
  rawCases: readonly PragmaAgentEvaluationCase[],
  size: number,
  seed: string,
): readonly string[] {
  const cases = rawCases.map((testCase) => PragmaAgentEvaluationCaseSchema.parse(testCase));
  if (!Number.isInteger(size) || size < 1 || size > cases.length) {
    throw new Error("evaluation_sample_size_invalid");
  }
  const shuffled = cases.map((testCase) => testCase.id);
  const random = seededRandom(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const next = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[next]] = [shuffled[next]!, shuffled[index]!];
  }
  return shuffled.slice(0, size);
}

export function evaluateAgentHardAssertions(input: {
  readonly case: PragmaAgentEvaluationCase;
  readonly output: string;
  readonly toolTrace: readonly z.infer<typeof AgentEvaluationToolTraceSchema>[];
}): readonly z.infer<typeof AgentEvaluationHardAssertionSchema>[] {
  const testCase = PragmaAgentEvaluationCaseSchema.parse(input.case);
  const trace = input.toolTrace.map((entry) => AgentEvaluationToolTraceSchema.parse(entry));
  const assertions: z.infer<typeof AgentEvaluationHardAssertionSchema>[] = [];
  for (const expected of testCase.assertions.outputContains) {
    assertions.push({
      kind: "output_contains",
      passed: input.output.includes(expected),
      message: `Output must contain ${JSON.stringify(expected)}.`,
    });
  }
  for (const forbidden of testCase.assertions.outputNotContains) {
    assertions.push({
      kind: "output_not_contains",
      passed: !input.output.includes(forbidden),
      message: `Output must not contain ${JSON.stringify(forbidden)}.`,
    });
  }
  for (const expected of testCase.assertions.tools) {
    const calls = trace.filter((entry) => entry.name === expected.name);
    const withinMaximum = expected.maxCalls === undefined || calls.length <= expected.maxCalls;
    assertions.push({
      kind: "tool_calls",
      passed: calls.length >= expected.minCalls && withinMaximum,
      message: `Tool ${expected.name} expected ${expected.minCalls}..${expected.maxCalls ?? "∞"} calls; observed ${calls.length}.`,
    });
    if (expected.inputMatches !== undefined) {
      assertions.push({
        kind: "tool_input",
        passed: calls.some((call) => partialMatch(call.input, expected.inputMatches)),
        message: `Tool ${expected.name} must receive an input matching the declared expectation.`,
      });
    }
  }
  return assertions.map((assertion) => AgentEvaluationHardAssertionSchema.parse(assertion));
}

export function summarizeAgentEvaluationTasks(
  tasks: readonly { readonly state: string; readonly result?: { readonly resolved: boolean } }[],
): z.infer<typeof AgentEvaluationSummarySchema> {
  const resolved = tasks.filter((task) => task.result?.resolved === true).length;
  const unresolved = tasks.filter((task) => task.result?.resolved === false).length;
  const completed = resolved + unresolved;
  const needsAttention = tasks.filter((task) => task.state === "needs_attention").length;
  const cancelled = tasks.filter((task) => task.state === "cancelled").length;
  return AgentEvaluationSummarySchema.parse({
    total: tasks.length,
    completed,
    resolved,
    unresolved,
    needsAttention,
    cancelled,
    resolvedRate: completed === 0 ? 0 : resolved / completed,
  });
}

function seededRandom(seed: string): () => number {
  let counter = 0;
  return () => {
    const digest = createHash("sha256").update(seed).update(":").update(String(counter++)).digest();
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => partialMatch(actual[index], value))
    );
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) => partialMatch(actual[key], value))
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type AgentEvaluationJudgeResult = z.infer<typeof AgentEvaluationJudgeResultSchema>;
export type AgentEvaluationCaseResult = z.infer<typeof AgentEvaluationCaseResultSchema>;
export type AgentEvaluationToolTrace = z.infer<typeof AgentEvaluationToolTraceSchema>;
