import type { z } from "zod";
import type { LoopState } from "@expertmesh/shared";

import type {
  CompiledLoop,
  Loop,
  LoopCodeHandler,
  LoopLimitPolicy,
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
} from "./types.ts";

export interface DefineLoopOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly result?: ((context: { state: LoopState }) => TOutput) | undefined;
}

export type LoopStepOptions<TInput = unknown, TOutput = unknown> = {
  readonly input?: LoopStepInputResolver<TInput> | TInput | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly reduce?: LoopStepReducer<TOutput> | undefined;
  readonly runtime?: string | undefined;
  readonly sandbox?: SandboxRequest | undefined;
};

export interface DefineCodeLoopOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly handler: LoopCodeHandler<TInput, TOutput>;
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

export class LoopSpec<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly inputSchema: z.ZodType<TInput> | undefined;
  readonly outputSchema: z.ZodType<TOutput> | undefined;
  readonly resolveOutput: ((context: { state: LoopState }) => TOutput) | undefined;

  private readonly steps = new Map<string, LoopStepDefinition>();
  private readonly transitions: LoopTransition[] = [];
  private readonly limits = new Map<string, LoopLimitPolicy>();
  private startStepId: string | undefined;

  constructor(options: DefineLoopOptions<TInput, TOutput>) {
    this.id = options.id;
    this.inputSchema = options.input;
    this.outputSchema = options.output;
    this.resolveOutput = options.result;
  }

  use<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    loop: Loop<TStepInput, TStepOutput>,
    options: LoopStepOptions<TStepInput, TStepOutput> = {},
  ): LoopStepRef<TStepOutput> {
    const step: LoopStepDefinition<TStepInput, TStepOutput> = {
      id,
      loop,
      input: options.input,
      output: options.output,
      reduce: options.reduce,
      runtime: options.runtime,
      sandbox: options.sandbox,
    };
    this.addStep(step as unknown as LoopStepDefinition);
    return createStepRef(step as unknown as LoopStepDefinition<unknown, TStepOutput>);
  }

  flow(declare: (builder: FlowBuilder) => void): this {
    const builder: FlowBuilder = {
      start: (step) => {
        this.assertKnownStep(step.id);
        if (this.startStepId !== undefined && this.startStepId !== step.id) {
          throw new Error(`Loop ${this.id} already has a start step: ${this.startStepId}`);
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

  compile(): CompiledLoop<TInput, TOutput> {
    if (this.startStepId === undefined) {
      throw new Error(`Loop ${this.id} does not declare a start step.`);
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

    const compiled: CompiledLoop<TInput, TOutput> = {
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

        const { createLoopApp } = await import("./loop-app.ts");
        return await createLoopApp().run(compiled, request);
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
      throw new Error(`Duplicate loop step id: ${step.id}`);
    }

    this.steps.set(step.id, step);
  }

  private assertKnownStep(stepId: string): void {
    if (!this.steps.has(stepId)) {
      throw new Error(`Loop ${this.id} references unknown step: ${stepId}`);
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
    private readonly spec: LoopSpec,
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

export function defineLoop<TInput = unknown, TOutput = unknown>(
  options: DefineLoopOptions<TInput, TOutput>,
): LoopSpec<TInput, TOutput> {
  return new LoopSpec(options);
}

export function defineCodeLoop<TInput = unknown, TOutput = unknown>(
  options: DefineCodeLoopOptions<TInput, TOutput>,
): Loop<TInput, TOutput> {
  return {
    id: options.id,
    inputSchema: options.input,
    outputSchema: options.output,
    async run(request) {
      if (request.execution === undefined) {
        const { createLoopApp } = await import("./loop-app.ts");
        return await createLoopApp().run(this, request);
      }

      const input = options.input?.parse(request.input) ?? request.input;
      const output = await options.handler({
        input,
        state: request.execution.state,
        workspace: request.execution.workspace,
        task: request.execution.task,
        workflow: request.execution.workflow,
        sandbox: request.execution.sandbox,
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

function isTerminalTarget(target: LoopTransitionTarget): target is LoopTerminalTarget {
  return "type" in target && (target.type === "end" || target.type === "fail");
}
