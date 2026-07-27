import { z } from "zod";

export const PragmaFlowRunDryAssertionSchema = z
  .object({
    kind: z.enum(["status", "path", "output", "error", "configuration"]),
    passed: z.boolean(),
    message: z.string(),
  })
  .strict();

export const PragmaFlowRunDryCaseResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    passed: z.boolean(),
    status: z.enum(["succeeded", "failed"]),
    path: z.array(z.string()),
    coveredTransitions: z.array(z.string()),
    assertions: z.array(PragmaFlowRunDryAssertionSchema),
    output: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict();

export const PragmaFlowRunDrySuiteResultSchema = z
  .object({
    passed: z.boolean(),
    cases: z.array(PragmaFlowRunDryCaseResultSchema),
    coverage: z
      .object({
        passed: z.boolean(),
        covered: z.array(z.string()),
        required: z.array(z.string()),
        missing: z.array(z.string()),
      })
      .strict(),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type PragmaFlowRunDryAssertion = z.infer<typeof PragmaFlowRunDryAssertionSchema>;
export type PragmaFlowRunDryCaseResult = z.infer<typeof PragmaFlowRunDryCaseResultSchema>;
export type PragmaFlowRunDrySuiteResult = z.infer<typeof PragmaFlowRunDrySuiteResultSchema>;
