import { z } from "zod";

const SEMANTIC_RESOURCE_ID = "[0-9a-hjkmnp-tv-z]{16}";

export const PragmaEvaluationRefSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^evaluation:${SEMANTIC_RESOURCE_ID}$`, "i"),
    "Expected an exact Pragma reference such as evaluation:7k2m9q4v8np6r3dt.",
  );

export const PragmaEvaluationFlowRefSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^flow:${SEMANTIC_RESOURCE_ID}$`, "i"),
    "Expected an exact Pragma Flow reference such as flow:7k2m9q4v8np6r3dt.",
  );

export const PragmaEvaluationMetadataSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(
        new RegExp(`^${SEMANTIC_RESOURCE_ID}$`),
        "Expected a 16-character lowercase Crockford Base32 resource ID.",
      ),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4_000),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  })
  .strict();

export const PragmaFlowRunDryMockOutcomeSchema = z.union([
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

export const PragmaFlowRunDryMockSequenceSchema = z.union([
  PragmaFlowRunDryMockOutcomeSchema,
  z.array(PragmaFlowRunDryMockOutcomeSchema).min(1).max(1_000),
]);

function runDryIdSchema(label: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use only letters, numbers, underscores, and hyphens.")
    .refine(
      (value) => !value.startsWith("__") && !["constructor", "prototype"].includes(value),
      `${label} cannot use reserved names.`,
    );
}

const EvaluationCaseIdSchema = runDryIdSchema("Evaluation case IDs");

export const PragmaFlowRunDryNodeIdSchema = runDryIdSchema("Flow node IDs");

export const PragmaFlowRunDryMocksSchema = z
  .record(z.string(), PragmaFlowRunDryMockSequenceSchema)
  .superRefine((mocks, context) => {
    for (const nodeId of Object.keys(mocks)) {
      const parsed = PragmaFlowRunDryNodeIdSchema.safeParse(nodeId);
      if (parsed.success) continue;
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: [nodeId, ...issue.path],
          message: issue.message,
        });
      }
    }
  });

export const PragmaFlowRunDryCaseSchema = z
  .object({
    id: EvaluationCaseIdSchema,
    name: z.string().trim().min(1).max(200),
    input: z.unknown(),
    mocks: PragmaFlowRunDryMocksSchema,
    expect: z
      .object({
        status: z.enum(["succeeded", "failed"]),
        path: z.array(PragmaFlowRunDryNodeIdSchema).max(1_000),
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

export const PragmaFlowRunDrySuiteSchema = z
  .object({
    cases: z.array(PragmaFlowRunDryCaseSchema).min(1).max(500),
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

export const PragmaEvaluationResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v3"),
    kind: z.literal("Evaluation"),
    metadata: PragmaEvaluationMetadataSchema,
    spec: z
      .object({
        target: z.object({ ref: PragmaEvaluationFlowRefSchema }).strict(),
        method: z
          .object({
            type: z.literal("flow-run-dry"),
            cases: PragmaFlowRunDrySuiteSchema.shape.cases,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

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

export type PragmaEvaluationResource = z.infer<typeof PragmaEvaluationResourceSchema>;
export type PragmaFlowRunDryMockOutcome = z.infer<typeof PragmaFlowRunDryMockOutcomeSchema>;
export type PragmaFlowRunDryCase = z.infer<typeof PragmaFlowRunDryCaseSchema>;
export type PragmaFlowRunDrySuite = z.infer<typeof PragmaFlowRunDrySuiteSchema>;
export type PragmaFlowRunDryAssertion = z.infer<typeof PragmaFlowRunDryAssertionSchema>;
export type PragmaFlowRunDryCaseResult = z.infer<typeof PragmaFlowRunDryCaseResultSchema>;
export type PragmaFlowRunDrySuiteResult = z.infer<typeof PragmaFlowRunDrySuiteResultSchema>;
