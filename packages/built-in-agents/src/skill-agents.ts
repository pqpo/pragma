import { createHash } from "node:crypto";

import {
  runSkillReplayEvaluation,
  SkillEvaluationAssertionSchema,
  type SkillEvaluationCase,
} from "@pragma/evaluation";
import { SkillPackageSchema, type SkillPackage } from "@pragma/shared";
import { z } from "zod";

import {
  SkillEvaluationSnapshotSchema,
  SkillRevisionChangeSetSchema,
  type ContextStoreRevisionProfile,
  type SkillEvaluationProfile,
  type SkillEvaluationSnapshot,
  type SkillRevisionChangeSet,
  type SkillRevisionRequest,
} from "./revision-contracts.ts";
import { extractStructuredJson } from "./structured-output.ts";
import { validateGeneratedSkillPackage } from "./skill-validation.ts";

export interface SkillRevisionExecutionPort {
  generate(input: {
    readonly jobId: string;
    readonly capabilityId: string;
    readonly title: string;
    readonly prompt: string;
    readonly profile: ContextStoreRevisionProfile;
  }): Promise<{ readonly content: string }>;
}

export interface SkillEvaluationExecutionResult {
  readonly content: string;
  readonly runtimeId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface SkillEvaluationExecutionPort {
  runSubject(input: {
    readonly jobId: string;
    readonly prompt: string;
    readonly profile: SkillEvaluationProfile;
  }): Promise<SkillEvaluationExecutionResult>;
  runJudge(input: {
    readonly jobId: string;
    readonly prompt: string;
    readonly profile: SkillEvaluationProfile;
  }): Promise<SkillEvaluationExecutionResult>;
}

export interface BuiltInSkillRevisionGenerator {
  generate(input: {
    readonly jobId: string;
    readonly request: SkillRevisionRequest;
    readonly current: SkillPackage;
    readonly revision: number;
    readonly contentHash: string;
  }): Promise<SkillRevisionChangeSet>;
}

export interface BuiltInSkillRevisionEvaluator {
  evaluate(input: {
    readonly jobId: string;
    readonly package: SkillPackage;
    readonly request: SkillRevisionRequest;
  }): Promise<SkillEvaluationSnapshot>;
}

export interface BuiltInSkillAgents {
  readonly revisionGenerator: BuiltInSkillRevisionGenerator;
  readonly revisionEvaluator: BuiltInSkillRevisionEvaluator;
  evaluateCandidate(input: {
    readonly candidateId: string;
    readonly package: SkillPackage;
    readonly replayCases: readonly SkillReplayExpectation[];
    readonly boundaryCase: SkillReplayExpectation;
  }): Promise<SkillEvaluationSnapshot>;
}

interface SkillReplayExpectation {
  readonly objective: string;
  readonly requiredBehaviors: readonly string[];
  readonly forbiddenBehaviors: readonly string[];
}

export function createBuiltInSkillAgents(options: {
  readonly revisionProfiles: { getProfile(): Promise<ContextStoreRevisionProfile> };
  readonly evaluationProfiles: { get(): Promise<SkillEvaluationProfile> };
  readonly revisionExecution: SkillRevisionExecutionPort;
  readonly evaluationExecution: SkillEvaluationExecutionPort;
}): BuiltInSkillAgents {
  const evaluate = async (input: {
    readonly jobId: string;
    readonly package: SkillPackage;
    readonly replayCases: readonly SkillReplayExpectation[];
    readonly boundaryCase: SkillReplayExpectation;
  }): Promise<SkillEvaluationSnapshot> => {
    const skill = SkillPackageSchema.parse(input.package);
    const validation = await validateGeneratedSkillPackage(skill);
    const cases: SkillEvaluationCase[] = [
      ...input.replayCases.map((testCase, index) => ({
        id: `source-${index + 1}`,
        kind: "source-replay" as const,
        objective: testCase.objective,
        requiredBehaviors: [...testCase.requiredBehaviors],
        forbiddenBehaviors: [...testCase.forbiddenBehaviors],
      })),
      {
        id: "not-applicable",
        kind: "boundary" as const,
        objective: input.boundaryCase.objective,
        requiredBehaviors: [...input.boundaryCase.requiredBehaviors],
        forbiddenBehaviors: [...input.boundaryCase.forbiddenBehaviors],
      },
    ];
    const profile = await options.evaluationProfiles.get();
    let observedRuntime: Omit<SkillEvaluationExecutionResult, "content"> | undefined;
    const rememberRuntime = (execution: SkillEvaluationExecutionResult): string => {
      observedRuntime ??= {
        runtimeId: execution.runtimeId,
        providerId: execution.providerId,
        modelId: execution.modelId,
      };
      return execution.content;
    };
    const result = await runSkillReplayEvaluation({
      cases,
      staticChecksPassed: validation.staticChecksPassed,
      scriptTestsPassed: validation.scriptTestsPassed,
      subject: {
        run: async ({ case: testCase }) =>
          rememberRuntime(
            await options.evaluationExecution.runSubject({
              jobId: input.jobId,
              profile,
              prompt: JSON.stringify({
                task: "Apply the candidate Skill to the case. For boundary cases, explicitly decline when it does not apply. Return only the proposed response or action plan.",
                skill,
                case: testCase,
              }),
            }),
          ),
      },
      judge: {
        evaluate: async ({ case: testCase, output }) =>
          z.array(SkillEvaluationAssertionSchema).parse(
            JSON.parse(
              extractStructuredJson(
                rememberRuntime(
                  await options.evaluationExecution.runJudge({
                    jobId: input.jobId,
                    profile,
                    prompt: JSON.stringify({
                      task: "Judge the candidate Skill response. Return a JSON array of assertions covering applicability, correctness, completeness, recovery, and safety.",
                      case: testCase,
                      output,
                    }),
                  }),
                ),
              ),
            ),
          ),
      },
    });
    const runtime = observedRuntime ?? {
      runtimeId: profile.model?.runtimeId ?? "runtime-managed",
      providerId: profile.model?.providerId ?? "runtime-managed",
      modelId: profile.model?.modelId ?? "runtime-default",
    };
    return SkillEvaluationSnapshotSchema.parse({
      schemaVersion: "pragma.skill-evaluation-snapshot/v1",
      subjectHash: packageHash(skill),
      passed: result.passed,
      staticChecksPassed: result.staticChecksPassed,
      scriptTestsPassed: result.scriptTestsPassed,
      profileRevision: profile.revision,
      ...runtime,
      cases: result.cases.map((testCase, index) => ({
        id: testCase.id,
        kind: cases[index]!.kind,
        passed: testCase.passed,
        assertions: testCase.assertions,
      })),
      evaluatedAt: result.evaluatedAt,
    });
  };

  return {
    revisionGenerator: {
      async generate(input) {
        const profile = await options.revisionProfiles.getProfile();
        const output = await options.revisionExecution.generate({
          jobId: input.jobId,
          capabilityId: input.request.capabilityId,
          title: "Revise Skill Capability",
          profile,
          prompt: JSON.stringify({
            capabilityId: input.request.capabilityId,
            task: "Return exactly one pragma.skill-revision-change-set/v1 JSON object. Make the smallest coherent change, preserve unrelated files, and keep scripts as dependency-free Node ESM with node:test coverage.",
            request: input.request.prompt,
            baseRevision: input.revision,
            baseContentHash: input.contentHash,
            currentSkill: input.current,
          }),
        });
        return SkillRevisionChangeSetSchema.parse(
          JSON.parse(extractStructuredJson(output.content)),
        );
      },
    },
    revisionEvaluator: {
      async evaluate(input) {
        return await evaluate({
          jobId: input.jobId,
          package: input.package,
          replayCases: input.request.replayCases ?? defaultReplayCases(input.request.prompt),
          boundaryCase: input.request.boundaryCase ?? defaultBoundaryCase(),
        });
      },
    },
    async evaluateCandidate(input) {
      return await evaluate({
        jobId: input.candidateId,
        package: input.package,
        replayCases: input.replayCases,
        boundaryCase: input.boundaryCase,
      });
    },
  };
}

export function applySkillChangeSet(
  base: SkillPackage,
  rawChangeSet: SkillRevisionChangeSet,
): SkillPackage {
  const changeSet = SkillRevisionChangeSetSchema.parse(rawChangeSet);
  const files = new Map(base.files.map((file) => [file.path, file.content]));
  for (const operation of changeSet.operations) {
    if (operation.operation === "delete") files.delete(operation.path);
    else if (operation.operation === "rename") {
      const content = files.get(operation.path);
      if (content === undefined || files.has(operation.nextPath)) {
        throw new Error("skill_revision_rename_invalid");
      }
      files.delete(operation.path);
      files.set(operation.nextPath, content);
    } else files.set(operation.path, operation.content);
  }
  return SkillPackageSchema.parse({
    name: changeSet.name,
    description: changeSet.description,
    files: [...files]
      .map(([path, content]) => ({ path, content }))
      .toSorted((left, right) => left.path.localeCompare(right.path)),
  });
}

function defaultReplayCases(prompt: string): readonly SkillReplayExpectation[] {
  return [1, 2, 3].map((index) => ({
    objective: `Apply the requested Skill revision in representative case ${index}: ${prompt}`,
    requiredBehaviors: ["Follow the revised Skill correctly."],
    forbiddenBehaviors: ["Invent unavailable context or unsafe actions."],
  }));
}

function defaultBoundaryCase(): SkillReplayExpectation {
  return {
    objective: "A request clearly outside this Skill's stated applicability.",
    requiredBehaviors: ["Recognize that the Skill does not apply."],
    forbiddenBehaviors: ["Force the Skill onto an unrelated task."],
  };
}

function packageHash(skill: SkillPackage): string {
  return createHash("sha256").update(JSON.stringify(skill)).digest("hex");
}
