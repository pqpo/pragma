import type { RunState } from "@pragma/shared";
import type { z } from "zod";

import { compileDirectiveDefinition, defineFlow, type StepOptions } from "./flow-spec.ts";
import type {
  Directive,
  DirectiveDefinition,
  DirectiveExecutionContext,
  RuntimeOverride,
  RunResult,
  StepInputContext,
  StepInputResolver,
  StepReducer,
  MaybePromise,
  SandboxRequest,
  StartRunRequest,
} from "./types.ts";
import { readObjectField } from "./utils.ts";

const workflowPatternStateKey = "workflowPatterns";

export interface WorkflowPatternStep<TInput = unknown, TOutput = unknown> extends RuntimeOverride {
  readonly id?: string | undefined;
  readonly directive: DirectiveDefinition<TInput, TOutput>;
  readonly input?: StepInputResolver<TInput> | TInput | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly reduce?: StepReducer<TOutput> | undefined;
  readonly sandbox?: SandboxRequest | undefined;
}

export type WorkflowPatternStepLike<TInput = unknown, TOutput = unknown> =
  | WorkflowPatternStep<TInput, TOutput>
  | DirectiveDefinition<TInput, TOutput>;

export interface DefinePromptChainWorkflowOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly steps: readonly WorkflowPatternStepLike[];
  readonly result?: ((context: { state: RunState }) => TOutput) | undefined;
}

export interface DefineRoutingWorkflowOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly router: WorkflowPatternStepLike<TInput>;
  readonly field: string;
  readonly routes: Readonly<Record<string, WorkflowPatternStepLike>>;
  readonly fallback?: WorkflowPatternStepLike | undefined;
  readonly result?: ((context: { state: RunState }) => TOutput) | undefined;
}

export interface WorkflowParallelBranch<
  TInput = unknown,
  TBranchInput = unknown,
  TOutput = unknown,
> extends RuntimeOverride {
  readonly directive: DirectiveDefinition<TBranchInput, TOutput>;
  readonly input?:
    | TBranchInput
    | ((context: WorkflowParallelBranchInputContext<TInput>) => MaybePromise<TBranchInput>)
    | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
}

export interface WorkflowParallelBranchInputContext<TInput = unknown> {
  readonly input: TInput;
  readonly branchId: string;
  readonly state: RunState;
}

export interface WorkflowParallelMergeContext<TInput = unknown> {
  readonly input: TInput;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly state: RunState;
}

export interface DefineParallelWorkflowOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly branches: Readonly<Record<string, WorkflowParallelBranch<TInput> | DirectiveDefinition>>;
  readonly merge?: (context: WorkflowParallelMergeContext<TInput>) => MaybePromise<TOutput>;
}

export interface WorkflowWorkerResult<TWorkerInput = unknown, TWorkerOutput = unknown> {
  readonly input: TWorkerInput;
  readonly output: TWorkerOutput;
}

export interface WorkflowWorkerSelectionContext<TInput = unknown, TPlan = unknown> {
  readonly input: TInput;
  readonly orchestration: TPlan;
  readonly state: RunState;
}

export interface WorkflowSynthesisInput<
  TInput = unknown,
  TPlan = unknown,
  TWorkerInput = unknown,
  TWorkerOutput = unknown,
> {
  readonly input: TInput;
  readonly orchestration: TPlan;
  readonly workerOutputs: readonly WorkflowWorkerResult<TWorkerInput, TWorkerOutput>[];
}

export interface DefineOrchestratorWorkersWorkflowOptions<
  TInput = unknown,
  TPlan = unknown,
  TWorkerInput = unknown,
  TWorkerOutput = unknown,
  TOutput = unknown,
> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly orchestrator: WorkflowPatternStepLike<TInput, TPlan>;
  readonly worker: WorkflowPatternStepLike<TWorkerInput, TWorkerOutput>;
  readonly getWorkerInputs?:
    | ((
        context: WorkflowWorkerSelectionContext<TInput, TPlan>,
      ) => MaybePromise<readonly TWorkerInput[]>)
    | undefined;
  readonly synthesizer?:
    | WorkflowPatternStepLike<
        WorkflowSynthesisInput<TInput, TPlan, TWorkerInput, TWorkerOutput>,
        TOutput
      >
    | undefined;
  readonly synthesize?:
    | ((
        context: WorkflowSynthesisInput<TInput, TPlan, TWorkerInput, TWorkerOutput> & {
          readonly state: RunState;
        },
      ) => MaybePromise<TOutput>)
    | undefined;
}

export interface WorkflowOptimizerInputContext<
  TInput = unknown,
  TAttempt = unknown,
  TEvaluation = unknown,
> {
  readonly input: TInput;
  readonly iteration: number;
  readonly previousAttempt?: TAttempt | undefined;
  readonly evaluation?: TEvaluation | undefined;
  readonly state: RunState;
}

export interface WorkflowEvaluatorInputContext<TInput = unknown, TAttempt = unknown> {
  readonly input: TInput;
  readonly attempt: TAttempt;
  readonly iteration: number;
  readonly state: RunState;
}

export interface WorkflowEvaluationDecisionContext<
  TInput = unknown,
  TAttempt = unknown,
  TEvaluation = unknown,
> {
  readonly input: TInput;
  readonly attempt: TAttempt;
  readonly evaluation: TEvaluation;
  readonly iteration: number;
  readonly state: RunState;
}

export interface WorkflowEvaluatorOptimizerResult<TAttempt = unknown, TEvaluation = unknown> {
  readonly accepted: boolean;
  readonly attempt: TAttempt;
  readonly evaluation: TEvaluation;
  readonly iterations: number;
}

export interface DefineEvaluatorOptimizerWorkflowOptions<
  TInput = unknown,
  TOptimizerInput = unknown,
  TAttempt = unknown,
  TEvaluatorInput = unknown,
  TEvaluation = unknown,
  TOutput = WorkflowEvaluatorOptimizerResult<TAttempt, TEvaluation>,
> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly optimizer: WorkflowPatternStepLike<TOptimizerInput, TAttempt>;
  readonly evaluator: WorkflowPatternStepLike<TEvaluatorInput, TEvaluation>;
  readonly maxIterations?: number | undefined;
  readonly buildOptimizerInput?:
    | ((
        context: WorkflowOptimizerInputContext<TInput, TAttempt, TEvaluation>,
      ) => MaybePromise<TOptimizerInput>)
    | undefined;
  readonly buildEvaluatorInput?:
    | ((context: WorkflowEvaluatorInputContext<TInput, TAttempt>) => MaybePromise<TEvaluatorInput>)
    | undefined;
  readonly accept?:
    | ((context: WorkflowEvaluationDecisionContext<TInput, TAttempt, TEvaluation>) => boolean)
    | undefined;
  readonly result?:
    | ((
        context: WorkflowEvaluatorOptimizerResult<TAttempt, TEvaluation> & {
          readonly input: TInput;
          readonly state: RunState;
        },
      ) => MaybePromise<TOutput>)
    | undefined;
  readonly onMaxIterations?: "fail" | "return-last" | undefined;
}

export function definePromptChainWorkflow<TInput = unknown, TOutput = unknown>(
  options: DefinePromptChainWorkflowOptions<TInput, TOutput>,
) {
  if (options.steps.length === 0) {
    throw new Error(`Prompt chain workflow ${options.id} must declare at least one step.`);
  }

  const flow = defineFlow({
    id: options.id,
    version: options.version,
    input: options.input,
    output: options.output,
    result: options.result ?? (({ state }) => state.results["final"] as TOutput),
  });
  const steps = options.steps.map((step) => normalizePatternStep(step));
  const stepRefs = steps.map((step, index) => {
    const stepId = step.id ?? resolveDirectiveDefinitionId(step.directive) ?? `step-${index + 1}`;
    const previous = index === 0 ? undefined : steps[index - 1];
    const previousId =
      previous === undefined
        ? undefined
        : (previous.id ?? resolveDirectiveDefinitionId(previous.directive) ?? `step-${index}`);
    const stepOptions = createStepOptions(step, {
      input:
        step.input ??
        (previousId === undefined
          ? undefined
          : (context: StepInputContext) =>
              getRequiredPatternStepOutput(context.state, options.id, previousId)),
      reduce: async (context) => {
        setPatternStepOutput(context.state, options.id, stepId, context.output);

        if (index === options.steps.length - 1) {
          context.state.results["final"] = context.output;
        }

        await step.reduce?.(context);
      },
    });

    return flow.use(stepId, step.directive, stepOptions);
  });

  flow.compose(({ start, end }) => {
    const first = stepRefs[0];

    if (first === undefined) {
      throw new Error(`Prompt chain workflow ${options.id} must declare at least one step.`);
    }

    let chain = start(first);

    for (const step of stepRefs.slice(1)) {
      chain = chain.next(step);
    }

    chain.next(end());
  });

  return flow;
}

export function defineRoutingWorkflow<TInput = unknown, TOutput = unknown>(
  options: DefineRoutingWorkflowOptions<TInput, TOutput>,
) {
  if (Object.keys(options.routes).length === 0) {
    throw new Error(`Routing workflow ${options.id} must declare at least one route.`);
  }

  const flow = defineFlow({
    id: options.id,
    version: options.version,
    input: options.input,
    output: options.output,
    result: options.result ?? (({ state }) => state.results["final"] as TOutput),
  });
  const routerSpec = normalizePatternStep(options.router);
  const routerId = routerSpec.id ?? resolveDirectiveDefinitionId(routerSpec.directive) ?? "router";
  const router = flow.use(
    routerId,
    routerSpec.directive,
    createStepOptions(routerSpec, {
      reduce: async (context) => {
        setPatternStepOutput(context.state, options.id, routerId, context.output);
        await routerSpec.reduce?.(context);
      },
    }),
  );
  const routeTargets: Record<string, ReturnType<typeof flow.use>> = {};

  for (const [caseId, route] of Object.entries(options.routes)) {
    const routeSpec = normalizePatternStep(route);
    const branchId = routeSpec.id ?? `route-${caseId}`;
    routeTargets[caseId] = flow.use(
      branchId,
      routeSpec.directive,
      createStepOptions(routeSpec, {
        reduce: async (context) => {
          context.state.results["final"] = context.output;
          setPatternStepOutput(context.state, options.id, branchId, context.output);
          await routeSpec.reduce?.(context);
        },
      }),
    );
  }

  const fallbackSpec =
    options.fallback === undefined ? undefined : normalizePatternStep(options.fallback);
  const fallback =
    fallbackSpec === undefined
      ? undefined
      : flow.use(
          fallbackSpec.id ?? "fallback",
          fallbackSpec.directive,
          createStepOptions(fallbackSpec, {
            reduce: async (context) => {
              context.state.results["final"] = context.output;
              setPatternStepOutput(
                context.state,
                options.id,
                fallbackSpec.id ?? "fallback",
                context.output,
              );
              await fallbackSpec.reduce?.(context);
            },
          }),
        );

  flow.compose(({ start, step, end }) => {
    start(router).route(options.field, routeTargets, fallback === undefined ? {} : { fallback });

    for (const target of Object.values(routeTargets)) {
      step(target).next(end());
    }

    if (fallback !== undefined) {
      step(fallback).next(end());
    }
  });

  return flow;
}

export function defineParallelWorkflow<TInput = unknown, TOutput = unknown>(
  options: DefineParallelWorkflowOptions<TInput, TOutput>,
): Directive<TInput, TOutput> {
  const branchEntries = Object.entries(options.branches);

  if (branchEntries.length === 0) {
    throw new Error(`Parallel workflow ${options.id} must declare at least one branch.`);
  }

  return createPatternDirective({
    id: options.id,
    version: options.version,
    inputSchema: options.input,
    outputSchema: options.output,
    execute: async ({ input, request, execution }) => {
      const branchResults = await Promise.all(
        branchEntries.map(async ([branchId, branch]) => {
          const normalized = normalizeParallelBranch(branch);
          const branchInput =
            typeof normalized.input === "function"
              ? await normalized.input({
                  input,
                  branchId,
                  state: execution.state,
                })
              : normalized.input !== undefined
                ? normalized.input
                : input;
          const output = await runNestedDirective({
            directive: normalized.directive,
            input: branchInput,
            output: normalized.output,
            runtime: normalized.runtime,
            request,
            execution,
          });

          return [branchId, output] as const;
        }),
      );
      const outputs = Object.fromEntries(branchResults);

      return options.merge === undefined
        ? (outputs as TOutput)
        : await options.merge({
            input,
            outputs,
            state: execution.state,
          });
    },
  });
}

export function defineOrchestratorWorkersWorkflow<
  TInput = unknown,
  TPlan = unknown,
  TWorkerInput = unknown,
  TWorkerOutput = unknown,
  TOutput = unknown,
>(
  options: DefineOrchestratorWorkersWorkflowOptions<
    TInput,
    TPlan,
    TWorkerInput,
    TWorkerOutput,
    TOutput
  >,
): Directive<TInput, TOutput> {
  const orchestrator = normalizePatternStep(options.orchestrator);
  const worker = normalizePatternStep(options.worker);
  const synthesizer =
    options.synthesizer === undefined ? undefined : normalizePatternStep(options.synthesizer);

  return createPatternDirective({
    id: options.id,
    version: options.version,
    inputSchema: options.input,
    outputSchema: options.output,
    execute: async ({ input, request, execution }) => {
      const orchestration = await runNestedDirective({
        directive: orchestrator.directive,
        input,
        output: orchestrator.output,
        runtime: orchestrator.runtime,
        request,
        execution,
      });
      const workerInputs =
        options.getWorkerInputs === undefined
          ? defaultGetWorkerInputs<TWorkerInput>(orchestration)
          : await options.getWorkerInputs({
              input,
              orchestration,
              state: execution.state,
            });
      const workerOutputs = await Promise.all(
        workerInputs.map(async (workerInput) => {
          const output = await runNestedDirective({
            directive: worker.directive,
            input: workerInput,
            output: worker.output,
            runtime: worker.runtime,
            request,
            execution,
          });

          return {
            input: workerInput,
            output,
          };
        }),
      );
      const synthesisInput: WorkflowSynthesisInput<TInput, TPlan, TWorkerInput, TWorkerOutput> = {
        input,
        orchestration,
        workerOutputs,
      };

      if (synthesizer !== undefined) {
        return await runNestedDirective({
          directive: synthesizer.directive,
          input: synthesisInput,
          output: synthesizer.output,
          runtime: synthesizer.runtime,
          request,
          execution,
        });
      }

      if (options.synthesize !== undefined) {
        return await options.synthesize({
          ...synthesisInput,
          state: execution.state,
        });
      }

      return synthesisInput as TOutput;
    },
  });
}

export function defineEvaluatorOptimizerWorkflow<
  TInput = unknown,
  TOptimizerInput = unknown,
  TAttempt = unknown,
  TEvaluatorInput = unknown,
  TEvaluation = unknown,
  TOutput = WorkflowEvaluatorOptimizerResult<TAttempt, TEvaluation>,
>(
  options: DefineEvaluatorOptimizerWorkflowOptions<
    TInput,
    TOptimizerInput,
    TAttempt,
    TEvaluatorInput,
    TEvaluation,
    TOutput
  >,
): Directive<TInput, TOutput> {
  const maxIterations = options.maxIterations ?? 3;
  const optimizer = normalizePatternStep(options.optimizer);
  const evaluator = normalizePatternStep(options.evaluator);

  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`Evaluator optimizer workflow ${options.id} requires maxIterations >= 1.`);
  }

  return createPatternDirective({
    id: options.id,
    version: options.version,
    inputSchema: options.input,
    outputSchema: options.output,
    execute: async ({ input, request, execution }) => {
      let previousAttempt: TAttempt | undefined;
      let previousEvaluation: TEvaluation | undefined;

      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const optimizerInput =
          options.buildOptimizerInput === undefined
            ? defaultBuildOptimizerInput<TInput, TOptimizerInput, TAttempt, TEvaluation>({
                input,
                iteration,
                previousAttempt,
                evaluation: previousEvaluation,
                state: execution.state,
              })
            : await options.buildOptimizerInput({
                input,
                iteration,
                previousAttempt,
                evaluation: previousEvaluation,
                state: execution.state,
              });
        const attempt = await runNestedDirective({
          directive: optimizer.directive,
          input: optimizerInput,
          output: optimizer.output,
          runtime: optimizer.runtime,
          request,
          execution,
        });
        const evaluatorInput =
          options.buildEvaluatorInput === undefined
            ? (attempt as unknown as TEvaluatorInput)
            : await options.buildEvaluatorInput({
                input,
                attempt,
                iteration,
                state: execution.state,
              });
        const evaluation = await runNestedDirective({
          directive: evaluator.directive,
          input: evaluatorInput,
          output: evaluator.output,
          runtime: evaluator.runtime,
          request,
          execution,
        });
        const accepted =
          options.accept?.({
            input,
            attempt,
            evaluation,
            iteration,
            state: execution.state,
          }) ?? defaultAcceptEvaluation(evaluation);

        if (accepted || iteration === maxIterations) {
          const baseResult: WorkflowEvaluatorOptimizerResult<TAttempt, TEvaluation> = {
            accepted,
            attempt,
            evaluation,
            iterations: iteration,
          };

          if (!accepted && options.onMaxIterations !== "return-last") {
            throw new Error(
              `Evaluator optimizer workflow ${options.id} did not satisfy the evaluator within ${maxIterations} iterations.`,
            );
          }

          return options.result === undefined
            ? (baseResult as TOutput)
            : await options.result({
                ...baseResult,
                input,
                state: execution.state,
              });
        }

        previousAttempt = attempt;
        previousEvaluation = evaluation;
      }

      throw new Error(`Evaluator optimizer workflow ${options.id} ended unexpectedly.`);
    },
  });
}

export const patterns = {
  promptChain: definePromptChainWorkflow,
  routing: defineRoutingWorkflow,
  parallel: defineParallelWorkflow,
  orchestratorWorkers: defineOrchestratorWorkersWorkflow,
  evaluatorOptimizer: defineEvaluatorOptimizerWorkflow,
};

interface CreatePatternDirectiveOptions<TInput, TOutput> {
  readonly id: string;
  readonly version: string;
  readonly inputSchema?: z.ZodType<TInput> | undefined;
  readonly outputSchema?: z.ZodType<TOutput> | undefined;
  readonly execute: (context: {
    readonly input: TInput;
    readonly request: StartRunRequest<TInput>;
    readonly execution: DirectiveExecutionContext;
  }) => MaybePromise<TOutput>;
}

function createPatternDirective<TInput, TOutput>(
  options: CreatePatternDirectiveOptions<TInput, TOutput>,
): Directive<TInput, TOutput> {
  const directive: Directive<TInput, TOutput> = {
    id: options.id,
    version: options.version,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    async run(request) {
      if (request.execution === undefined) {
        const { createPragma } = await import("./pragma-app.ts");
        return await createPragma().run(directive, request);
      }

      const input = options.inputSchema?.parse(request.input) ?? request.input;
      const output = await options.execute({
        input,
        request,
        execution: request.execution,
      });
      const parsedOutput = options.outputSchema?.parse(output) ?? output;

      return {
        workflowRunId: request.execution.workflow.id,
        output: parsedOutput,
        state: request.execution.state,
      };
    },
  };

  return directive;
}

function createStepOptions<TOutput>(
  step: WorkflowPatternStep<unknown, TOutput>,
  overrides: {
    readonly input?: StepOptions["input"] | undefined;
    readonly reduce?: StepReducer<TOutput> | undefined;
  } = {},
): StepOptions<unknown, TOutput> {
  const input = overrides.input ?? step.input;
  const reduce = overrides.reduce ?? step.reduce;

  return {
    ...(input === undefined ? {} : { input }),
    ...(step.output === undefined ? {} : { output: step.output }),
    ...(reduce === undefined ? {} : { reduce }),
    ...(step.runtime === undefined ? {} : { runtime: step.runtime }),
    ...(step.sandbox === undefined ? {} : { sandbox: step.sandbox }),
  };
}

async function runNestedDirective<TInput, TOutput>(options: {
  readonly directive: DirectiveDefinition<TInput, TOutput>;
  readonly input: TInput;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly runtime?: string | undefined;
  readonly request: StartRunRequest<unknown>;
  readonly execution: DirectiveExecutionContext;
}): Promise<TOutput> {
  let request: StartRunRequest<TInput> = {
    input: options.input,
    execution: options.execution,
  };

  if (options.output !== undefined) {
    request = {
      ...request,
      output: options.output,
    };
  }

  if (options.runtime !== undefined || options.request.runtime !== undefined) {
    request = {
      ...request,
      runtime: options.runtime ?? options.request.runtime,
    };
  }

  if (options.request.runtimes !== undefined) {
    request = {
      ...request,
      runtimes: options.request.runtimes,
    };
  }

  const result: RunResult<TOutput> = await options.execution.runDirective(
    compileDirectiveDefinition(options.directive),
    request,
  );
  return result.output;
}

function normalizeParallelBranch<TInput>(
  branch: WorkflowParallelBranch<TInput> | DirectiveDefinition,
): WorkflowParallelBranch<TInput> {
  if (isParallelBranch(branch)) {
    return branch;
  }

  return {
    directive: branch,
  };
}

function isParallelBranch<TInput>(
  branch: WorkflowParallelBranch<TInput> | DirectiveDefinition,
): branch is WorkflowParallelBranch<TInput> {
  return isRecord(branch) && "directive" in branch;
}

function normalizePatternStep<TInput, TOutput>(
  step: WorkflowPatternStepLike<TInput, TOutput>,
): WorkflowPatternStep<TInput, TOutput> {
  if (isRecord(step) && "directive" in step) {
    return step as WorkflowPatternStep<TInput, TOutput>;
  }

  return {
    directive: step as DirectiveDefinition<TInput, TOutput>,
  };
}

function resolveDirectiveDefinitionId(directive: DirectiveDefinition): string | undefined {
  if (isRecord(directive) && typeof directive["id"] === "string") {
    return directive["id"];
  }

  return undefined;
}

function getWorkflowPatternState(state: RunState): Record<string, unknown> {
  const current = state.private[workflowPatternStateKey];

  if (isRecord(current)) {
    return current;
  }

  const created: Record<string, unknown> = {};
  state.private[workflowPatternStateKey] = created;
  return created;
}

function getPatternState(state: RunState, patternId: string): Record<string, unknown> {
  const patterns = getWorkflowPatternState(state);
  const current = patterns[patternId];

  if (isRecord(current)) {
    return current;
  }

  const created: Record<string, unknown> = {};
  patterns[patternId] = created;
  return created;
}

function setPatternStepOutput(
  state: RunState,
  patternId: string,
  stepId: string,
  output: unknown,
): void {
  const patternState = getPatternState(state, patternId);
  const outputs = isRecord(patternState["outputs"])
    ? patternState["outputs"]
    : (patternState["outputs"] = {});
  outputs[stepId] = output;
}

function getRequiredPatternStepOutput(state: RunState, patternId: string, stepId: string): unknown {
  const patternState = getPatternState(state, patternId);
  const outputs = patternState["outputs"];

  if (!isRecord(outputs) || !(stepId in outputs)) {
    throw new Error(`Workflow ${patternId} cannot resolve previous step output: ${stepId}`);
  }

  return outputs[stepId];
}

function defaultGetWorkerInputs<TWorkerInput>(orchestration: unknown): readonly TWorkerInput[] {
  const tasks = readObjectField(orchestration, "tasks");

  if (!Array.isArray(tasks)) {
    throw new Error("Orchestrator output must include a tasks array or getWorkerInputs.");
  }

  return tasks as readonly TWorkerInput[];
}

function defaultBuildOptimizerInput<TInput, TOptimizerInput, TAttempt, TEvaluation>(
  context: WorkflowOptimizerInputContext<TInput, TAttempt, TEvaluation>,
): TOptimizerInput {
  if (context.iteration === 1) {
    return context.input as unknown as TOptimizerInput;
  }

  return {
    input: context.input,
    previousAttempt: context.previousAttempt,
    evaluation: context.evaluation,
    iteration: context.iteration,
  } as TOptimizerInput;
}

function defaultAcceptEvaluation(evaluation: unknown): boolean {
  const accepted = readObjectField(evaluation, "accepted");

  if (typeof accepted === "boolean") {
    return accepted;
  }

  const approved = readObjectField(evaluation, "approved");

  if (typeof approved === "boolean") {
    return approved;
  }

  const status = readObjectField(evaluation, "status");

  if (typeof status === "string") {
    return ["accepted", "approved", "pass", "passed", "success", "succeeded"].includes(status);
  }

  throw new Error(
    "Evaluator output must include accepted/approved boolean, status string, or a custom accept predicate.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
