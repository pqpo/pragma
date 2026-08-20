import { runFlowRunDryEvaluation, type PragmaFlowRunDrySuiteResult } from "@pragma/evaluation";

import { analyzePragmaFlowGraph } from "../ast/flow-graph.ts";
import {
  PragmaFlowRunDryEvaluationResourceSchema,
  PragmaFlowPromptSchema,
  PragmaFlowResourceSchema,
  type PragmaFlowRunDryEvaluationResource,
  type PragmaFlowResource,
} from "../ast/pragma-dsl.schema.ts";
import { evaluatePragmaFlowValue, renderPragmaFlowPrompt } from "../runtime/flow-values.ts";

export function runPragmaEvaluation(
  rawFlow: PragmaFlowResource,
  rawEvaluation: PragmaFlowRunDryEvaluationResource,
): PragmaFlowRunDrySuiteResult {
  const flow = PragmaFlowResourceSchema.parse(rawFlow);
  const evaluation = PragmaFlowRunDryEvaluationResourceSchema.parse(rawEvaluation);
  const targetRef = `flow:${flow.metadata.id}`;
  if (evaluation.spec.target.ref !== targetRef) {
    throw new Error(
      `Evaluation ${evaluation.metadata.id} targets ${evaluation.spec.target.ref}, not ${targetRef}.`,
    );
  }
  return runFlowRunDryEvaluation(
    flow,
    { cases: evaluation.spec.method.cases },
    {
      analyzeGraph: () => analyzePragmaFlowGraph(flow),
      evaluateValue: evaluatePragmaFlowValue,
      renderPrompt: (prompt, state, flowInput) =>
        renderPragmaFlowPrompt(PragmaFlowPromptSchema.parse(prompt), state, flowInput),
    },
  );
}

export { listRequiredPragmaFlowDryTransitions } from "@pragma/evaluation";
