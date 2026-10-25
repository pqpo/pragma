import { z } from "zod";
import * as historical from "../schemas/v5.ts";

// Frozen writer shapes: authoring drafts may omit a Flow start or have no Evaluation cases.
const flowSpec = historical.PragmaFlowResourceSchema.shape.spec;
const flow = z
  .object({
    apiVersion: z.literal("pragma/v5"),
    kind: z.literal("Flow"),
    metadata: historical.PragmaMetadataSchema,
    spec: z
      .object({
        input: flowSpec.shape.input,
        output: flowSpec.shape.output,
        limits: flowSpec.shape.limits,
        graph: z
          .object({
            ...flowSpec.shape.graph.shape,
            start: flowSpec.shape.graph.shape.start.optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const evaluationSpec = historical.PragmaFlowRunDryEvaluationResourceSchema.shape.spec;
const evaluation = z
  .object({
    apiVersion: z.literal("pragma/v5"),
    kind: z.literal("Evaluation"),
    metadata: historical.PragmaFlowRunDryEvaluationResourceSchema.shape.metadata,
    spec: z
      .object({
        target: evaluationSpec.shape.target,
        method: z
          .object({
            type: z.literal("flow-run-dry"),
            cases: z.array(evaluationSpec.shape.method.shape.cases.element).max(500),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

/** Pure adjacent upgrade; the owner validates the resulting current draft shape. */
export function migratePragmaV5AuthoringResourceToV6(input: unknown): unknown {
  const resource = z.union([flow, evaluation]).parse(input);
  return { ...resource, apiVersion: "pragma/v6" };
}
