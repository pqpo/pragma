import type { z } from "zod";
import type { LoopState } from "@expertmesh/shared";

import type { ExpertAgent } from "../agent/expert-agent.ts";
import type {
  AgentLoopStepDefinition,
  CodeLoopStepDefinition,
  CompiledLoop,
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
  SubloopStepDefinition,
  TaskEnvironmentRequest,
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
  readonly environment?: TaskEnvironmentRequest | undefined;
};

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

  agent<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    agent: ExpertAgent,
    options: LoopStepOptions<TStepInput, TStepOutput> = {},
  ): LoopStepRef<TStepOutput> {
    const step: AgentLoopStepDefinition<TStepInput, TStepOutput> = {
      id,
      kind: "agent",
      agent,
      input: options.input,
      output: options.output,
      reduce: options.reduce,
      runtime: options.runtime,
      environment: options.environment,
    };
    this.addStep(step as unknown as LoopStepDefinition);
    return createStepRef(step as unknown as LoopStepDefinition<unknown, TStepOutput>);
  }

  code<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    handler: LoopCodeHandler<TStepInput, TStepOutput>,
    options: LoopStepOptions<TStepInput, TStepOutput> = {},
  ): LoopStepRef<TStepOutput> {
    const step: CodeLoopStepDefinition<TStepInput, TStepOutput> = {
      id,
      kind: "code",
      handler,
      input: options.input,
      output: options.output,
      reduce: options.reduce,
      runtime: options.runtime,
      environment: options.environment,
    };
    this.addStep(step as unknown as LoopStepDefinition);
    return createStepRef(step as unknown as LoopStepDefinition<unknown, TStepOutput>);
  }

  subloop<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    loop: CompiledLoop<TStepInput, TStepOutput> | { compile: () => CompiledLoop<TStepInput, TStepOutput> },
    options: LoopStepOptions<TStepInput, TStepOutput> = {},
  ): LoopStepRef<TStepOutput> {
    const compiledLoop = "compile" in loop ? loop.compile() : loop;
    const step: SubloopStepDefinition<TStepInput, TStepOutput> = {
      id,
      kind: "subloop",
      loop: compiledLoop,
      input: options.input,
      output: options.output,
      reduce: options.reduce,
      runtime: options.runtime,
      environment: options.environment,
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

    return {
      id: this.id,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      resolveOutput: this.resolveOutput,
      steps: new Map(this.steps),
      startStepId: this.startStepId,
      transitions: [...this.transitions],
      limits: new Map(this.limits),
    };
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
    output: step.output,
  };
}

export function defineLoop<TInput = unknown, TOutput = unknown>(
  options: DefineLoopOptions<TInput, TOutput>,
): LoopSpec<TInput, TOutput> {
  return new LoopSpec(options);
}

function isTerminalTarget(target: LoopTransitionTarget): target is LoopTerminalTarget {
  return "type" in target && (target.type === "end" || target.type === "fail");
}
