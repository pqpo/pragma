import { z } from "zod";

export const SkillEvaluationAssertionSchema = z
  .object({
    dimension: z.enum(["applicability", "correctness", "completeness", "recovery", "safety"]),
    passed: z.boolean(),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const SkillEvaluationCaseSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: z.enum(["source-replay", "boundary"]),
    objective: z.string().trim().min(1).max(4_000),
    requiredBehaviors: z.array(z.string().trim().min(1).max(2_000)).min(1).max(20),
    forbiddenBehaviors: z.array(z.string().trim().min(1).max(2_000)).max(20),
  })
  .strict();

export const SkillEvaluationCaseResultSchema = z
  .object({
    id: z.string().min(1),
    passed: z.boolean(),
    output: z.string().max(32_000),
    assertions: z.array(SkillEvaluationAssertionSchema).min(1).max(25),
  })
  .strict();

export const SkillEvaluationResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.skill-evaluation-result/v1"),
    passed: z.boolean(),
    cases: z.array(SkillEvaluationCaseResultSchema).min(4).max(20),
    staticChecksPassed: z.boolean(),
    scriptTestsPassed: z.boolean(),
    evaluatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((result, context) => {
    const expected =
      result.staticChecksPassed &&
      result.scriptTestsPassed &&
      result.cases.every(
        (testCase) => testCase.passed && testCase.assertions.every((assertion) => assertion.passed),
      );
    if (result.passed !== expected) {
      context.addIssue({ code: "custom", path: ["passed"], message: "Skill evaluation pass state is inconsistent." });
    }
    if (!result.cases.some((testCase) => testCase.id.startsWith("boundary:"))) {
      context.addIssue({ code: "custom", path: ["cases"], message: "A boundary case is required." });
    }
  });

export interface SkillEvaluationSubject {
  run(input: { readonly case: z.infer<typeof SkillEvaluationCaseSchema>; readonly signal?: AbortSignal }): Promise<string>;
}

export interface SkillEvaluationJudge {
  evaluate(input: {
    readonly case: z.infer<typeof SkillEvaluationCaseSchema>;
    readonly output: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly z.infer<typeof SkillEvaluationAssertionSchema>[]>;
}

export async function runSkillReplayEvaluation(input: {
  readonly cases: readonly z.input<typeof SkillEvaluationCaseSchema>[];
  readonly subject: SkillEvaluationSubject;
  readonly judge: SkillEvaluationJudge;
  readonly staticChecksPassed: boolean;
  readonly scriptTestsPassed: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}): Promise<z.infer<typeof SkillEvaluationResultSchema>> {
  const cases = input.cases.map((testCase) => SkillEvaluationCaseSchema.parse(testCase));
  if (cases.filter((testCase) => testCase.kind === "source-replay").length < 3) {
    throw new Error("skill_evaluation_requires_three_source_replays");
  }
  if (cases.filter((testCase) => testCase.kind === "boundary").length < 1) {
    throw new Error("skill_evaluation_requires_boundary_case");
  }
  const results = [];
  for (const testCase of cases) {
    input.signal?.throwIfAborted();
    const output = await input.subject.run({
      case: testCase,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const assertions = z
      .array(SkillEvaluationAssertionSchema)
      .min(1)
      .max(25)
      .parse(
        await input.judge.evaluate({
          case: testCase,
          output,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }),
      );
    results.push({
      id: testCase.kind === "boundary" ? `boundary:${testCase.id}` : testCase.id,
      passed: assertions.every((assertion) => assertion.passed),
      output,
      assertions,
    });
  }
  return SkillEvaluationResultSchema.parse({
    schemaVersion: "pragma.skill-evaluation-result/v1",
    passed:
      input.staticChecksPassed &&
      input.scriptTestsPassed &&
      results.every((result) => result.passed),
    cases: results,
    staticChecksPassed: input.staticChecksPassed,
    scriptTestsPassed: input.scriptTestsPassed,
    evaluatedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
}

export type SkillEvaluationCase = z.infer<typeof SkillEvaluationCaseSchema>;
export type SkillEvaluationAssertion = z.infer<typeof SkillEvaluationAssertionSchema>;
export type SkillEvaluationResult = z.infer<typeof SkillEvaluationResultSchema>;
