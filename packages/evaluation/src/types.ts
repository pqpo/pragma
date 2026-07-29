export interface FlowRunDryPrompt {
  readonly segments: readonly (
    | { readonly text: string }
    | {
        readonly variable:
          | { readonly source: "flow-input"; readonly path: readonly string[] }
          | {
              readonly source: "node-output";
              readonly nodeId: string;
              readonly path: readonly string[];
            };
      }
  )[];
}

export interface FlowRunDryStep {
  readonly expert?: unknown;
  readonly team?: unknown;
  readonly human?:
    | {
        readonly selectionMode: "single" | "multiple";
        readonly prompt: FlowRunDryPrompt;
        readonly options: readonly { readonly value: string }[];
      }
    | undefined;
  readonly prompt?: FlowRunDryPrompt | undefined;
  readonly input?: unknown;
  readonly output?: { readonly schema: unknown } | undefined;
}

export type FlowRunDryTarget =
  | string
  | { readonly goto: string }
  | { readonly end: true }
  | { readonly fail: string };

export type FlowRunDryDestination =
  | FlowRunDryTarget
  | { readonly repeat: { readonly loop: string; readonly goto: string } };

export type FlowRunDryTransition =
  | FlowRunDryDestination
  | {
      readonly route: string;
      readonly cases: Readonly<Record<string, FlowRunDryDestination>>;
      readonly fallback?: FlowRunDryDestination | undefined;
    }
  | {
      readonly route: string;
      readonly branches: readonly {
        readonly id: string;
        readonly operator: "contains_any" | "contains_all" | "contains_none";
        readonly values: readonly string[];
        readonly destination: FlowRunDryDestination;
      }[];
      readonly fallback?: FlowRunDryDestination | undefined;
    };

export interface FlowRunDrySubject {
  readonly metadata: { readonly id: string };
  readonly spec: {
    readonly input?: { readonly schema: unknown } | undefined;
    readonly output?: { readonly schema: unknown; readonly value?: unknown } | undefined;
    readonly limits: { readonly maxNodeVisits: number };
    readonly graph: {
      readonly start: string;
      readonly steps: Readonly<Record<string, FlowRunDryStep>>;
      readonly loops: Readonly<
        Record<
          string,
          {
            readonly entry: string;
            readonly maxIterations: number;
            readonly onLimit?: FlowRunDryTarget | undefined;
          }
        >
      >;
      readonly transitions: Readonly<Record<string, FlowRunDryTransition>>;
    };
  };
}

export interface FlowRunDryGraphAnalysis {
  readonly issues: readonly { readonly message: string }[];
  readonly loopMembers: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface FlowRunDryRuntime {
  readonly analyzeGraph: (flow: FlowRunDrySubject) => FlowRunDryGraphAnalysis;
  readonly evaluateValue: (
    value: unknown,
    state: Readonly<Record<string, unknown>>,
    flowInput: unknown,
    nodeOutput?: unknown,
  ) => unknown;
  readonly renderPrompt: (
    prompt: FlowRunDryPrompt,
    state: Readonly<Record<string, unknown>>,
    flowInput: unknown,
  ) => string;
}
