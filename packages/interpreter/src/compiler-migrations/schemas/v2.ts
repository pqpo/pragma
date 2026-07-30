import { z } from "zod";

import { PragmaFlowNodeIdSchema } from "../../ast/pragma-dsl.schema.ts";

const PragmaCompilerV2FlowRunDryMockOutcomeSchema = z.union([
  z
    .object({
      expectInput: z.unknown(),
      expectPrompt: z.string().max(20_000).optional(),
      output: z.unknown(),
    })
    .strict(),
  z
    .object({
      expectInput: z.unknown(),
      expectPrompt: z.string().max(20_000).optional(),
      error: z.string().trim().min(1).max(4_000),
    })
    .strict(),
]);

const PragmaCompilerV2FlowRunDryMockSequenceSchema = z.union([
  PragmaCompilerV2FlowRunDryMockOutcomeSchema,
  z.array(PragmaCompilerV2FlowRunDryMockOutcomeSchema).min(1).max(1_000),
]);

const PragmaCompilerV2FlowRunDryCaseSchema = z
  .object({
    id: PragmaFlowNodeIdSchema,
    name: z.string().trim().min(1).max(200),
    input: z.unknown(),
    mocks: z.record(PragmaFlowNodeIdSchema, PragmaCompilerV2FlowRunDryMockSequenceSchema),
    expect: z
      .object({
        status: z.enum(["succeeded", "failed"]),
        path: z.array(PragmaFlowNodeIdSchema).max(1_000),
        output: z.unknown().optional(),
        errorContains: z.string().trim().min(1).max(4_000).optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.status === "succeeded" && value.errorContains !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["errorContains"],
            message: "A successful run dry case cannot expect an error.",
          });
        }
        if (value.status === "failed" && value.output !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["output"],
            message: "A failed run dry case cannot expect an output.",
          });
        }
        if (value.status === "failed" && value.errorContains === undefined) {
          context.addIssue({
            code: "custom",
            path: ["errorContains"],
            message: "A failed run dry case must assert an error fragment.",
          });
        }
      }),
  })
  .strict();

/**
 * Exact snapshot of the runDry branch written by compiler v2 before commit 4f3f96c.
 * Unchanged Flow fields are parsed by the current schema only after this historical
 * field has been validated and removed by the migration step.
 */
export const PragmaCompilerV2FlowRunDrySuiteSchema = z
  .object({
    cases: z.array(PragmaCompilerV2FlowRunDryCaseSchema).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.cases.forEach((testCase, index) => {
      if (ids.has(testCase.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: "Run dry case IDs must be unique.",
        });
      }
      ids.add(testCase.id);
    });
  });
