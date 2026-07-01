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
  LoopLimitPolicy,
  MaybePromise,
  LoopNextTransition,
  LoopRouteTransition,
  LoopStepDefinition,
  LoopStepInputResolver,
  LoopStepReducer,
  LoopStepRef,
  LoopTerminalTarget,
  LoopTransition,
  LoopTransitionTarget,
  SandboxRequest,
  TaskContext,
  TaskHandler,
} from "./types.ts";

export interface DefineFlowOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly result?: ((context: { state: RunState }) => TOutput) | undefined;
}

export type LoopStepOptions<TInput = unknown, TOutput = unknown> = {
  readonly input?: LoopStepInputResolver<TInput> | TInput | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly reduce?: LoopStepReducer<TOutput> | undefined;
  readonly runtime?: string | undefined;
  readonly sandbox?: SandboxRequest | undefined;
};

export interface DefineTaskOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly handler: TaskHandler<TInput, TOutput>;
}

export interface DefineHumanTaskOptions<TInput = unknown, TOutput = HumanInteractionResponse> {
  readonly id: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly request:
    | HumanInteractionRequest
    | ((context: TaskContext<TInput>) => MaybePromise<HumanInteractionRequest>);
}

export type RouteCases = Readonly<Record<string, LoopTransitionTarget>>;

export interface RouteOptions {
  readonly fallback?: LoopTransitionTarget | undefined;
}

export interface FlowBuilder {
  readonly start: (step: LoopStepRef) => FlowChain;
  readonly step: (step: LoopStepRef) => FlowChain;
  readonly end: () => LoopTerminalTarget;
  readonly fail: (reason?: string) => LoopTerminalTarget;
}

export interface FlowChain {
  readonly next: (step: LoopStepRef | LoopTerminalTarget) => FlowChain;
  readonly route: (field: string, cases: RouteCases, options?: RouteOptions) => FlowChain;
  readonly limit: (policy: LoopLimitPolicy) => FlowChain;
}

export class FlowSpec<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly inputSchema: z.ZodType<TInput> | undefined;
  readonly outputSchema: z.ZodType<TOutput> | undefined;
  readonly resolveOutput: ((context: { state: RunState }) => TOutput) | undefined;

  private readonly steps = new Map<string, LoopStepDefinition>();
  private readonly transitions: LoopTransition[] = [];
  private readonly limits = new Map<string, LoopLimitPolicy>();
  private startStepId: string | undefined;

  constructor(options: DefineFlowOptions<TInput, TOutput>) {
    this.id = options.id;
    this.inputSchema = options.input;
    this.outputSchema = options.output;
    this.resolveOutput = options.result;
  }

  use<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    loop: DirectiveDefinition<TStepInput, TStepOutput>,
    options: LoopStepOptions<TStepInput, TStepOutput> = {},
  ): LoopStepRef<TStepOutput> {
    const runnable = compileLoopDefinition(loop);
    const step: LoopStepDefinition<TStepInput, TStepOutput> = {
      id,
      loop: runnable,
      input: options.input,
      output: options.output,
      reduce: options.reduce,
      runtime: options.runtime,
      sandbox: options.sandbox,
    };
    this.addStep(step as unknown as LoopStepDefinition);
    return createStepRef(step as unknown as LoopStepDefinition<unknown, TStepOutput>);
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
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      resolveOutput: this.resolveOutput,
      steps: new Map(this.steps),
      startStepId: this.startStepId,
      transitions: [...this.transitions],
      limits: new Map(this.limits),
      async run(request) {
        const runLoop = request.execution?.runLoop;

        if (runLoop !== undefined) {
          return await runLoop(compiled, request);
        }

        const { createPragma } = await import("./loop-app.ts");
        return await createPragma().run(compiled, request);
      },
    };

    return compiled;
  }

  addTransition(transition: LoopTransition): void {
    this.transitions.push(transition);
  }

  setLimit(stepId: string, policy: LoopLimitPolicy): void {
    this.assertKnownStep(stepId);
    this.limits.set(stepId, policy);
  }

  private addStep(step: LoopStepDefinition): void {
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

  private assertKnownTarget(target: LoopTransitionTarget): void {
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

  next(step: LoopStepRef | LoopTerminalTarget): FlowChain {
    const transition: LoopNextTransition = {
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
    const transition: LoopRouteTransition = {
      type: "route",
      from: this.currentStepId,
      field,
      cases: new Map(Object.entries(cases)),
      fallback: options.fallback,
    };
    this.spec.addTransition(transition);
    return this;
  }

  limit(policy: LoopLimitPolicy): FlowChain {
    this.spec.setLimit(this.currentStepId, policy);
    return this;
  }
}

function createStepRef<TOutput>(step: LoopStepDefinition<unknown, TOutput>): LoopStepRef<TOutput> {
  return {
    id: step.id,
    output: step.output ?? step.loop.outputSchema,
  };
}

export function compileLoopDefinition<TInput, TOutput>(
  loop: DirectiveDefinition<TInput, TOutput>,
): Directive<TInput, TOutput> {
  return "compile" in loop ? loop.compile() : loop;
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
    inputSchema: options.input,
    outputSchema: options.output,
    async run(request) {
      if (request.execution === undefined) {
        const { createPragma } = await import("./loop-app.ts");
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
    inputSchema: options.input,
    outputSchema,
    async run(request) {
      if (request.execution === undefined) {
        const { createPragma } = await import("./loop-app.ts");
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

function isTerminalTarget(target: LoopTransitionTarget): target is LoopTerminalTarget {
  return "type" in target && (target.type === "end" || target.type === "fail");
}
