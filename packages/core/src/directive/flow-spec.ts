import type { z } from "zod";
import {
  HumanInteractionResponseSchema,
  type HumanInteractionRequest,
  type HumanInteractionResponse,
  type RunState,
} from "@pragma/shared";

import type {
  CompiledDirective,
  Directive,
  DirectiveDefinition,
  StepLimitPolicy,
  MaybePromise,
  NextTransition,
  RouteTransition,
  StepDefinition,
  StepInputResolver,
  StepReducer,
  StepRef,
  TerminalTarget,
  Transition,
  TransitionTarget,
  SandboxRequest,
  TaskContext,
  TaskHandler,
} from "./types.ts";

export interface DefineFlowOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly result?: ((context: { state: RunState }) => TOutput) | undefined;
}

export type StepOptions<TInput = unknown, TOutput = unknown> = {
  readonly input?: StepInputResolver<TInput> | TInput | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly reduce?: StepReducer<TOutput> | undefined;
  readonly runtime?: string | undefined;
  readonly sandbox?: SandboxRequest | undefined;
};

export interface DefineTaskOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly handler: TaskHandler<TInput, TOutput>;
}

export interface DefineHumanTaskOptions<TInput = unknown, TOutput = HumanInteractionResponse> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly request:
    | HumanInteractionRequest
    | ((context: TaskContext<TInput>) => MaybePromise<HumanInteractionRequest>);
}

export type RouteCases = Readonly<Record<string, TransitionTarget>>;

export interface RouteOptions {
  readonly fallback?: TransitionTarget | undefined;
}

export interface FlowBuilder {
  readonly start: (step: StepRef) => FlowChain;
  readonly step: (step: StepRef) => FlowChain;
  readonly end: () => TerminalTarget;
  readonly fail: (reason?: string) => TerminalTarget;
}

export interface FlowChain {
  readonly next: (step: StepRef | TerminalTarget) => FlowChain;
  readonly route: (field: string, cases: RouteCases, options?: RouteOptions) => FlowChain;
  readonly limit: (policy: StepLimitPolicy) => FlowChain;
}

export class FlowSpec<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly inputSchema: z.ZodType<TInput> | undefined;
  readonly outputSchema: z.ZodType<TOutput> | undefined;
  readonly resolveOutput: ((context: { state: RunState }) => TOutput) | undefined;

  private readonly steps = new Map<string, StepDefinition>();
  private readonly transitions: Transition[] = [];
  private readonly limits = new Map<string, StepLimitPolicy>();
  private startStepId: string | undefined;

  constructor(options: DefineFlowOptions<TInput, TOutput>) {
    this.id = options.id;
    this.version = options.version;
    this.inputSchema = options.input;
    this.outputSchema = options.output;
    this.resolveOutput = options.result;
  }

  use<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    directive: DirectiveDefinition<TStepInput, TStepOutput>,
    options: StepOptions<TStepInput, TStepOutput> = {},
  ): StepRef<TStepOutput> {
    const runnable = compileDirectiveDefinition(directive);
    const step: StepDefinition<TStepInput, TStepOutput> = {
      id,
      directive: runnable,
      input: options.input,
      output: options.output,
      reduce: options.reduce,
      runtime: options.runtime,
      sandbox: options.sandbox,
    };
    this.addStep(step as unknown as StepDefinition);
    return createStepRef(step as unknown as StepDefinition<unknown, TStepOutput>);
  }

  compose(declare: (builder: FlowBuilder) => void): this {
    const builder: FlowBuilder = {
      start: (step) => {
        this.assertKnownStep(step.id);
        if (this.startStepId !== undefined && this.startStepId !== step.id) {
          throw new Error(`Flow ${this.id} already has a start step: ${this.startStepId}`);
        }

        this.startStepId = step.id;
        return new MutableFlowChain(this, step.id);
      },
      step: (step) => {
        this.assertKnownStep(step.id);
        return new MutableFlowChain(this, step.id);
      },
      end: () => ({ type: "end" }),
      fail: (reason) => ({ type: "fail", reason }),
    };

    declare(builder);
    return this;
  }

  compile(): CompiledDirective<TInput, TOutput> {
    if (this.startStepId === undefined) {
      throw new Error(`Flow ${this.id} does not declare a start step.`);
    }

    for (const transition of this.transitions) {
      this.assertKnownStep(transition.from);

      if (transition.type === "next") {
        this.assertKnownTarget(transition.to);
      } else {
        for (const target of transition.cases.values()) {
          this.assertKnownTarget(target);
        }

        if (transition.fallback !== undefined) {
          this.assertKnownTarget(transition.fallback);
        }
      }
    }

    const compiled: CompiledDirective<TInput, TOutput> = {
      id: this.id,
      version: this.version,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      resolveOutput: this.resolveOutput,
      steps: new Map(this.steps),
      startStepId: this.startStepId,
      transitions: [...this.transitions],
      limits: new Map(this.limits),
      async run(request) {
        const runDirective = request.execution?.runDirective;

        if (runDirective !== undefined) {
          return await runDirective(compiled, request);
        }

        const { createPragma } = await import("./pragma-app.ts");
        return await createPragma().run(compiled, request);
      },
    };

    return compiled;
  }

  addTransition(transition: Transition): void {
    this.transitions.push(transition);
  }

  setLimit(stepId: string, policy: StepLimitPolicy): void {
    this.assertKnownStep(stepId);
    this.limits.set(stepId, policy);
  }

  private addStep(step: StepDefinition): void {
    if (this.steps.has(step.id)) {
      throw new Error(`Duplicate flow step id: ${step.id}`);
    }

    this.steps.set(step.id, step);
  }

  private assertKnownStep(stepId: string): void {
    if (!this.steps.has(stepId)) {
      throw new Error(`Flow ${this.id} references unknown step: ${stepId}`);
    }
  }

  private assertKnownTarget(target: TransitionTarget): void {
    if (isTerminalTarget(target)) {
      return;
    }

    this.assertKnownStep(target.id);
  }
}

class MutableFlowChain implements FlowChain {
  constructor(
    private readonly spec: FlowSpec,
    private readonly currentStepId: string,
  ) {}

  next(step: StepRef | TerminalTarget): FlowChain {
    const transition: NextTransition = {
      type: "next",
      from: this.currentStepId,
      to: step,
    };
    this.spec.addTransition(transition);

    if (isTerminalTarget(step)) {
      return this;
    }

    return new MutableFlowChain(this.spec, step.id);
  }

  route(field: string, cases: RouteCases, options: RouteOptions = {}): FlowChain {
    const transition: RouteTransition = {
      type: "route",
      from: this.currentStepId,
      field,
      cases: new Map(Object.entries(cases)),
      fallback: options.fallback,
    };
    this.spec.addTransition(transition);
    return this;
  }

  limit(policy: StepLimitPolicy): FlowChain {
    this.spec.setLimit(this.currentStepId, policy);
    return this;
  }
}

function createStepRef<TOutput>(step: StepDefinition<unknown, TOutput>): StepRef<TOutput> {
  return {
    id: step.id,
    output: step.output ?? step.directive.outputSchema,
  };
}

export function compileDirectiveDefinition<TInput, TOutput>(
  directive: DirectiveDefinition<TInput, TOutput>,
): Directive<TInput, TOutput> {
  return "compile" in directive ? directive.compile() : directive;
}

export function defineFlow<TInput = unknown, TOutput = unknown>(
  options: DefineFlowOptions<TInput, TOutput>,
): FlowSpec<TInput, TOutput> {
  return new FlowSpec(options);
}

export function defineTask<TInput = unknown, TOutput = unknown>(
  options: DefineTaskOptions<TInput, TOutput>,
): Directive<TInput, TOutput> {
  return {
    id: options.id,
    version: options.version,
    inputSchema: options.input,
    outputSchema: options.output,
    async run(request) {
      if (request.execution === undefined) {
        const { createPragma } = await import("./pragma-app.ts");
        return await createPragma().run(this, request);
      }

      const input = options.input?.parse(request.input) ?? request.input;
      const output = await options.handler({
        input,
        state: request.execution.state,
        workspace: request.execution.workspace,
        task: request.execution.task,
        workflow: request.execution.workflow,
        sandbox: request.execution.sandbox,
        emitProgress: request.execution.emitProgress,
      });
      const parsedOutput = options.output?.parse(output) ?? output;

      return {
        workflowRunId: request.execution.workflow.id,
        output: parsedOutput,
        state: request.execution.state,
      };
    },
  };
}

export function defineHumanTask<TInput = unknown, TOutput = HumanInteractionResponse>(
  options: DefineHumanTaskOptions<TInput, TOutput>,
): Directive<TInput, TOutput> {
  const outputSchema =
    options.output ?? (HumanInteractionResponseSchema as unknown as z.ZodType<TOutput>);

  return {
    id: options.id,
    version: options.version,
    inputSchema: options.input,
    outputSchema,
    async run(request) {
      if (request.execution === undefined) {
        const { createPragma } = await import("./pragma-app.ts");
        return await createPragma().run(this, request);
      }

      const input = options.input?.parse(request.input) ?? request.input;
      const taskContext: TaskContext<TInput> = {
        input,
        state: request.execution.state,
        workspace: request.execution.workspace,
        task: request.execution.task,
        workflow: request.execution.workflow,
        sandbox: request.execution.sandbox,
        emitProgress: request.execution.emitProgress,
      };
      const interactionRequest =
        typeof options.request === "function"
          ? await options.request(taskContext)
          : options.request;
      const response = await request.execution.requestHumanInteraction({
        request: interactionRequest,
      });
      const parsedOutput = outputSchema.parse(response);

      return {
        workflowRunId: request.execution.workflow.id,
        output: parsedOutput,
        state: request.execution.state,
      };
    },
  };
}

function isTerminalTarget(target: TransitionTarget): target is TerminalTarget {
  return "type" in target && (target.type === "end" || target.type === "fail");
}
