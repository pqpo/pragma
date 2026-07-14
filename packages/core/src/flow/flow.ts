import type { HumanInteractionRequest, HumanInteractionResponse } from "@pragma/shared";
import type { z } from "zod";

import type { ExpertDefinition } from "../agent/expert-team.ts";
import type { ContextIdResolver } from "../execution/context-id-resolver.ts";

export type FlowState = Record<string, unknown>;
export type FlowNodeDefinition = FlowTaskDefinition | HumanTaskDefinition | ExpertDefinition | Flow;

export interface FlowTaskContext<TInput = unknown> {
  readonly input: TInput;
  readonly state: FlowState;
  readonly executionId: string;
  readonly invocationId: string;
  readonly emitOutput: (value: unknown) => Promise<void>;
}

export interface FlowTaskDefinition<TInput = unknown, TOutput = unknown> {
  readonly kind: "task";
  readonly id: string;
  readonly version: string;
  readonly inputSchema?: z.ZodType<TInput> | undefined;
  readonly outputSchema?: z.ZodType<TOutput> | undefined;
  readonly handler: (context: FlowTaskContext<TInput>) => TOutput | Promise<TOutput>;
}

export interface HumanTaskDefinition<TInput = unknown> {
  readonly kind: "human-task";
  readonly id: string;
  readonly version: string;
  readonly request:
    | HumanInteractionRequest
    | ((
        context: FlowTaskContext<TInput>,
      ) => HumanInteractionRequest | Promise<HumanInteractionRequest>);
}

export interface DefineFlowOptions<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType<TInput> | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly result?: ((context: { readonly state: FlowState }) => TOutput) | undefined;
}

export interface FlowStepOptions<TInput = unknown, TOutput = unknown> {
  readonly input?: TInput | ((context: { readonly state: FlowState }) => TInput) | undefined;
  readonly output?: z.ZodType<TOutput> | undefined;
  readonly reduce?:
    | ((context: { readonly state: FlowState; readonly output: TOutput }) => void)
    | undefined;
}

export interface FlowExpertStepOptions<TInput = unknown, TOutput = unknown> extends FlowStepOptions<
  TInput,
  TOutput
> {
  readonly runtime?: string | undefined;
  readonly contextId?: ContextIdResolver | undefined;
}

export interface FlowStepReference<TOutput = unknown> {
  readonly id: string;
  readonly output?: z.ZodType<TOutput> | undefined;
}

export interface FlowTerminal {
  readonly type: "end" | "fail";
  readonly reason?: string | undefined;
}

export interface FlowBuilder {
  start(step: FlowStepReference): FlowChain;
  step(step: FlowStepReference): FlowChain;
  end(): FlowTerminal;
  fail(reason?: string): FlowTerminal;
}

export interface FlowChain {
  next(target: FlowStepReference | FlowTerminal): FlowChain;
  route(
    field: string,
    cases: Readonly<Record<string, FlowStepReference | FlowTerminal>>,
    options?: { readonly fallback?: FlowStepReference | FlowTerminal | undefined },
  ): FlowChain;
}

export interface CompiledFlowStep {
  readonly id: string;
  readonly definition: FlowNodeDefinition;
  readonly options: FlowStepOptions | FlowExpertStepOptions;
}

export interface Flow {
  readonly kind: "flow";
  readonly id: string;
  readonly version: string;
  readonly input?: z.ZodType | undefined;
  readonly output?: z.ZodType | undefined;
  readonly result?: ((context: { readonly state: FlowState }) => unknown) | undefined;
  readonly steps: ReadonlyMap<string, CompiledFlowStep>;
  readonly startStepId: string;
  readonly transitions: ReadonlyMap<string, FlowTransition>;
}

export type FlowTransition =
  | { readonly type: "next"; readonly target: FlowStepReference | FlowTerminal }
  | {
      readonly type: "route";
      readonly field: string;
      readonly cases: ReadonlyMap<string, FlowStepReference | FlowTerminal>;
      readonly fallback?: FlowStepReference | FlowTerminal | undefined;
    };

export class FlowSpec<TInput = unknown, TOutput = unknown> {
  readonly kind = "flow" as const;
  readonly id: string;
  readonly version: string;
  readonly input: z.ZodType<TInput> | undefined;
  readonly output: z.ZodType<TOutput> | undefined;
  readonly result: ((context: { readonly state: FlowState }) => TOutput) | undefined;
  private readonly stepDefinitions = new Map<string, CompiledFlowStep>();
  private readonly transitionDefinitions = new Map<string, FlowTransition>();
  private firstStepId: string | undefined;

  constructor(options: DefineFlowOptions<TInput, TOutput>) {
    this.id = options.id;
    this.version = options.version;
    this.input = options.input;
    this.output = options.output;
    this.result = options.result;
  }

  task<TStepInput = unknown, TStepOutput = unknown>(
    options: Omit<FlowTaskDefinition<TStepInput, TStepOutput>, "kind"> &
      FlowStepOptions<TStepInput, TStepOutput>,
  ): FlowStepReference<TStepOutput> {
    const { input, output, reduce, ...definition } = options;
    return this.addStep(
      options.id,
      { kind: "task", ...definition } as unknown as FlowNodeDefinition,
      {
        input,
        output,
        reduce,
      } as unknown as FlowStepOptions,
    );
  }

  humanTask<TStepInput = unknown>(
    options: Omit<HumanTaskDefinition<TStepInput>, "kind"> &
      FlowStepOptions<TStepInput, HumanInteractionResponse>,
  ): FlowStepReference<HumanInteractionResponse> {
    const { input, output, reduce, ...definition } = options;
    return this.addStep(
      options.id,
      { kind: "human-task", ...definition } as unknown as FlowNodeDefinition,
      {
        input,
        output,
        reduce,
      } as unknown as FlowStepOptions,
    );
  }

  use<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    definition: ExpertDefinition,
    options?: FlowExpertStepOptions<TStepInput, TStepOutput>,
  ): FlowStepReference<TStepOutput>;
  use<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    definition: Flow | FlowSpec,
    options?: FlowStepOptions<TStepInput, TStepOutput>,
  ): FlowStepReference<TStepOutput>;
  use<TStepInput = unknown, TStepOutput = unknown>(
    id: string,
    definition: ExpertDefinition | Flow | FlowSpec,
    options:
      | FlowStepOptions<TStepInput, TStepOutput>
      | FlowExpertStepOptions<TStepInput, TStepOutput> = {},
  ): FlowStepReference<TStepOutput> {
    const compiled = "compile" in definition ? definition.compile() : definition;
    if (!isExecutableDefinition(compiled)) {
      throw new Error(`Flow.use() only accepts Expert, ExpertTeam, or Flow: ${id}`);
    }
    return this.addStep(id, compiled, options as unknown as FlowStepOptions);
  }

  compose(declare: (builder: FlowBuilder) => void): this {
    const builder: FlowBuilder = {
      start: (step) => {
        this.assertStep(step.id);
        if (this.firstStepId !== undefined && this.firstStepId !== step.id) {
          throw new Error(`Flow ${this.id} already has a start step.`);
        }
        this.firstStepId = step.id;
        return new Chain(this, step.id);
      },
      step: (step) => {
        this.assertStep(step.id);
        return new Chain(this, step.id);
      },
      end: () => ({ type: "end" }),
      fail: (reason) => ({ type: "fail", ...(reason === undefined ? {} : { reason }) }),
    };
    declare(builder);
    return this;
  }

  compile(): Flow {
    if (this.firstStepId === undefined) throw new Error(`Flow ${this.id} has no start step.`);
    return Object.freeze({
      kind: "flow" as const,
      id: this.id,
      version: this.version,
      input: this.input,
      output: this.output,
      result: this.result,
      steps: new Map(this.stepDefinitions),
      startStepId: this.firstStepId,
      transitions: new Map(this.transitionDefinitions),
    });
  }

  setTransition(stepId: string, transition: FlowTransition): void {
    this.assertStep(stepId);
    this.transitionDefinitions.set(stepId, transition);
  }

  private addStep<TOutput>(
    id: string,
    definition: FlowNodeDefinition,
    options: FlowStepOptions,
  ): FlowStepReference<TOutput> {
    if (this.stepDefinitions.has(id)) throw new Error(`Duplicate Flow step id: ${id}`);
    this.stepDefinitions.set(id, { id, definition, options });
    return { id, output: options.output as z.ZodType<TOutput> | undefined };
  }

  private assertStep(id: string): void {
    if (!this.stepDefinitions.has(id)) throw new Error(`Unknown Flow step: ${id}`);
  }
}

class Chain implements FlowChain {
  constructor(
    private readonly flow: FlowSpec,
    private readonly stepId: string,
  ) {}

  next(target: FlowStepReference | FlowTerminal): FlowChain {
    this.flow.setTransition(this.stepId, { type: "next", target });
    return "id" in target ? new Chain(this.flow, target.id) : this;
  }

  route(
    field: string,
    cases: Readonly<Record<string, FlowStepReference | FlowTerminal>>,
    options: { readonly fallback?: FlowStepReference | FlowTerminal | undefined } = {},
  ): FlowChain {
    this.flow.setTransition(this.stepId, {
      type: "route",
      field,
      cases: new Map(Object.entries(cases)),
      fallback: options.fallback,
    });
    return this;
  }
}

export function defineFlow<TInput = unknown, TOutput = unknown>(
  options: DefineFlowOptions<TInput, TOutput>,
): FlowSpec<TInput, TOutput> {
  return new FlowSpec(options);
}

function isExecutableDefinition(value: unknown): value is ExpertDefinition | Flow {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "version" in value &&
    (!("kind" in value) || value.kind === "expert-team" || value.kind === "flow")
  );
}
