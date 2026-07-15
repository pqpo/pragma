import type { HumanInteractionRequest, HumanInteractionResponse } from "@pragma/shared";
import type { z } from "zod";

import {
  readAgentDelegationDefinition,
  type RuntimeByExpert,
} from "../agent/agent-launcher.ts";
import type { Expert } from "../agent/expert-agent.ts";
import { isExpertTeam, type ExpertDefinition } from "../agent/expert-team.ts";
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
  readonly runtimeByExpert?: RuntimeByExpert | undefined;
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
    if (!("kind" in compiled) || compiled.kind === "expert-team") {
      validateFlowRuntimeByExpert(
        compiled as ExpertDefinition,
        (options as FlowExpertStepOptions).runtimeByExpert,
        id,
      );
    }
    const runtimeByExpert = (options as FlowExpertStepOptions).runtimeByExpert;
    const normalizedOptions =
      runtimeByExpert === undefined
        ? options
        : { ...options, runtimeByExpert: Object.freeze({ ...runtimeByExpert }) };
    return this.addStep(id, compiled, normalizedOptions as unknown as FlowStepOptions);
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

function validateFlowRuntimeByExpert(
  definition: ExpertDefinition,
  runtimeByExpert: RuntimeByExpert | undefined,
  stepId: string,
): void {
  if (runtimeByExpert === undefined) return;
  const knownExpertIds = collectReachableExpertIds(definition);
  for (const [expertId, runtimeId] of Object.entries(runtimeByExpert)) {
    if (!knownExpertIds.has(expertId)) {
      throw new Error(`Flow step ${stepId} runtimeByExpert target is unknown: ${expertId}`);
    }
    if (runtimeId.trim() === "") {
      throw new Error(`Flow step ${stepId} runtimeByExpert value must not be empty: ${expertId}`);
    }
  }
}

function collectReachableExpertIds(definition: ExpertDefinition): ReadonlySet<string> {
  const expertIds = new Set<string>();
  const visitExpert = (expert: Expert): void => {
    if (expertIds.has(expert.id)) return;
    expertIds.add(expert.id);
    const launchers = new Set(
      (expert.tools ?? []).flatMap((tool) => {
        const launcher = readAgentDelegationDefinition(tool);
        return launcher === undefined ? [] : [launcher];
      }),
    );
    if (launchers.size > 1) {
      throw new Error(`Expert ${expert.id} has multiple agent launchers.`);
    }
    for (const target of [...launchers][0]?.experts ?? []) visitExpert(target);
  };
  if (isExpertTeam(definition)) {
    visitExpert(definition.coordinator);
    for (const member of definition.members) visitExpert(member);
  } else {
    visitExpert(definition);
  }
  return expertIds;
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
