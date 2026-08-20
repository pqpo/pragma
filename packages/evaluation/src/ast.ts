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

export const PragmaAgentEvaluationGroupSchema = z.string().trim().min(1).max(100);

export const PragmaAgentEvaluationCriterionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use only letters, numbers, underscores, and hyphens."),
    description: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const PragmaAgentEvaluationToolAssertionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    minCalls: z.number().int().min(0).max(100).default(1),
    maxCalls: z.number().int().min(0).max(100).optional(),
    inputMatches: z.unknown().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.maxCalls !== undefined && value.maxCalls < value.minCalls) {
      context.addIssue({
        code: "custom",
        path: ["maxCalls"],
        message: "maxCalls must be greater than or equal to minCalls.",
      });
    }
  });

export const PragmaAgentEvaluationAssertionsSchema = z
  .object({
    outputContains: z.array(z.string().min(1).max(2_000)).max(20).default([]),
    outputNotContains: z.array(z.string().min(1).max(2_000)).max(20).default([]),
    tools: z.array(PragmaAgentEvaluationToolAssertionSchema).max(50).default([]),
  })
  .strict();

export const PragmaAgentEvaluationMockOutcomeSchema = z.union([
  z.object({ expectInput: z.unknown(), output: z.unknown() }).strict(),
  z.object({ expectInput: z.unknown(), error: z.string().trim().min(1).max(4_000) }).strict(),
]);

export const PragmaAgentEvaluationMockToolSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    outcomes: z.array(PragmaAgentEvaluationMockOutcomeSchema).min(1).max(100),
  })
  .strict();

export const PragmaAgentEvaluationCaseSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use only letters, numbers, underscores, and hyphens."),
    name: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(100_000),
    referenceAnswer: z.string().trim().min(1).max(32_000).optional(),
    criteria: z.array(PragmaAgentEvaluationCriterionSchema).min(1).max(25),
    assertions: PragmaAgentEvaluationAssertionsSchema.default({
      outputContains: [],
      outputNotContains: [],
      tools: [],
    }),
    mocks: z.array(PragmaAgentEvaluationMockToolSchema).max(50).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const criterionIds = new Set<string>();
    value.criteria.forEach((criterion, index) => {
      if (criterionIds.has(criterion.id)) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "id"],
          message: "Criterion IDs must be unique within a case.",
        });
      }
      criterionIds.add(criterion.id);
    });
    const mockNames = new Set<string>();
    value.mocks.forEach((mock, index) => {
      if (mockNames.has(mock.name)) {
        context.addIssue({
          code: "custom",
          path: ["mocks", index, "name"],
          message: "Mock tool names must be unique within a case.",
        });
      }
      mockNames.add(mock.name);
    });
  });

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

export const PragmaFlowRunDryEvaluationResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v5"),
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

export const PragmaAgentJudgeEvaluationResourceSchema = z
  .object({
    apiVersion: z.literal("pragma/v5"),
    kind: z.literal("Evaluation"),
    metadata: PragmaEvaluationMetadataSchema,
    spec: z
      .object({
        method: z
          .object({
            type: z.literal("agent-judge"),
            group: PragmaAgentEvaluationGroupSchema,
            execution: z.object({ mode: z.enum(["mock", "live"]) }).strict(),
            cases: z.array(PragmaAgentEvaluationCaseSchema).min(1).max(500),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.spec.method.cases.forEach((testCase, index) => {
      if (ids.has(testCase.id)) {
        context.addIssue({
          code: "custom",
          path: ["spec", "method", "cases", index, "id"],
          message: "Evaluation case IDs must be unique.",
        });
      }
      ids.add(testCase.id);
      if (value.spec.method.execution.mode === "live" && testCase.mocks.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["spec", "method", "cases", index, "mocks"],
          message: "Live evaluation cases cannot declare mock tool outcomes.",
        });
      }
    });
  });

export const PragmaEvaluationResourceSchema = z.union([
  PragmaFlowRunDryEvaluationResourceSchema,
  PragmaAgentJudgeEvaluationResourceSchema,
]);

export const AgentEvaluationToolTraceSchema = z
  .object({
    name: z.string().min(1).max(200),
    status: z.enum(["succeeded", "failed"]),
    input: z.unknown().optional(),
    inputPreview: z.string().max(800).optional(),
    outputPreview: z.string().max(800).optional(),
    error: z.string().max(2_000).optional(),
  })
  .strict();

export const AgentEvaluationHardAssertionSchema = z
  .object({
    kind: z.enum(["output_contains", "output_not_contains", "tool_calls", "tool_input"]),
    passed: z.boolean(),
    message: z.string().min(1).max(2_000),
  })
  .strict();

export const AgentEvaluationJudgeCriterionResultSchema = z
  .object({
    id: z.string().min(1).max(100),
    passed: z.boolean(),
    score: z.number().min(0).max(100),
    evidence: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const AgentEvaluationJudgeResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.evaluation-judge-result/v1"),
    resolved: z.boolean(),
    criteria: z.array(AgentEvaluationJudgeCriterionResultSchema).min(1).max(25),
    summary: z.string().trim().min(1).max(4_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resolved !== value.criteria.every((criterion) => criterion.passed)) {
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: "Judge resolved state must equal the conjunction of criterion results.",
      });
    }
  });

export const AgentEvaluationCaseResultSchema = z
  .object({
    caseId: z.string().min(1).max(100),
    output: z.string().max(200_000),
    toolTrace: z.array(AgentEvaluationToolTraceSchema).max(1_000),
    assertions: z.array(AgentEvaluationHardAssertionSchema).max(100),
    judge: AgentEvaluationJudgeResultSchema,
    resolved: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.assertions.every((assertion) => assertion.passed) && value.judge.resolved;
    if (value.resolved !== expected) {
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: "Case resolved state is inconsistent with assertions and Judge verdict.",
      });
    }
  });

export const AgentEvaluationSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    resolvedRate: z.number().min(0).max(1),
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
export type PragmaFlowRunDryEvaluationResource = z.infer<
  typeof PragmaFlowRunDryEvaluationResourceSchema
>;
export type PragmaAgentJudgeEvaluationResource = z.infer<
  typeof PragmaAgentJudgeEvaluationResourceSchema
>;
export type PragmaAgentEvaluationCase = z.infer<typeof PragmaAgentEvaluationCaseSchema>;
export type PragmaFlowRunDryMockOutcome = z.infer<typeof PragmaFlowRunDryMockOutcomeSchema>;
export type PragmaFlowRunDryCase = z.infer<typeof PragmaFlowRunDryCaseSchema>;
export type PragmaFlowRunDrySuite = z.infer<typeof PragmaFlowRunDrySuiteSchema>;
export type PragmaFlowRunDryAssertion = z.infer<typeof PragmaFlowRunDryAssertionSchema>;
export type PragmaFlowRunDryCaseResult = z.infer<typeof PragmaFlowRunDryCaseResultSchema>;
export type PragmaFlowRunDrySuiteResult = z.infer<typeof PragmaFlowRunDrySuiteResultSchema>;
