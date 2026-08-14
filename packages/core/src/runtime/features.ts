import type {
  RuntimeFeatureSessionPrepareContext,
  RuntimeFeatureTurnPrepareContext,
} from "./driver.ts";
import type {
  RuntimeAdapterCapabilities,
  RuntimeAdapterPlacementCapabilities,
} from "./runtime-adapter.ts";

// RUNTIME_FEATURE_CATALOG_START
export const RUNTIME_FEATURE_CATALOG = [
  {
    name: "availability",
    lifecycle: "driver",
    enforcement: { kind: "driver-method", method: "canUse" },
    description: "Runtime availability probing",
  },
  {
    name: "authentication",
    lifecycle: "driver",
    enforcement: { kind: "conformance" },
    description: "Runtime authentication setup and validation",
  },
  {
    name: "modelDiscovery",
    lifecycle: "driver",
    enforcement: { kind: "driver-method", method: "listModels" },
    description: "Model catalog discovery",
  },
  {
    name: "modelSelection",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Per-Session or per-turn model selection",
  },
  {
    name: "thinking",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Thinking or reasoning level selection",
  },
  {
    name: "freshSession",
    lifecycle: "session",
    enforcement: { kind: "conformance" },
    description: "Fresh native Session creation",
  },
  {
    name: "resume",
    lifecycle: "session",
    enforcement: { kind: "conformance" },
    description: "Native Session restoration",
  },
  {
    name: "systemPrompt",
    lifecycle: "session",
    enforcement: { kind: "conformance" },
    description: "System prompt delivery",
  },
  {
    name: "startupMessages",
    lifecycle: "session",
    enforcement: { kind: "conformance" },
    description: "Startup message delivery and reinjection",
  },
  {
    name: "textStreaming",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Ordered text streaming",
  },
  {
    name: "reasoningStreaming",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Ordered reasoning streaming",
  },
  {
    name: "nativeToolLifecycle",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Native tool start, update, and completion events",
  },
  {
    name: "mcp",
    lifecycle: "session",
    enforcement: { kind: "implementation" },
    description: "MCP tool registration and execution",
  },
  {
    name: "permissions",
    lifecycle: "session",
    enforcement: { kind: "implementation" },
    description: "Tool permission policy and approval",
  },
  {
    name: "userInteraction",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Durable human interaction",
  },
  {
    name: "skills",
    lifecycle: "session",
    enforcement: { kind: "implementation" },
    description: "Skill materialization and invocation",
  },
  {
    name: "attachmentImage",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Image attachments",
  },
  {
    name: "attachmentFile",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "File attachments",
  },
  {
    name: "attachmentDirectory",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Directory attachments",
  },
  {
    name: "usage",
    lifecycle: "turn",
    enforcement: { kind: "conformance" },
    description: "Token usage observation",
  },
  {
    name: "contextWindow",
    lifecycle: "driver",
    enforcement: { kind: "driver-method", method: "readContextWindow" },
    description: "Context window inspection",
  },
  {
    name: "compaction",
    lifecycle: "session",
    enforcement: { kind: "driver-method", method: "compactContext", when: "manual-compaction" },
    description: "Context compaction and compaction events",
  },
  {
    name: "cancellation",
    lifecycle: "turn",
    enforcement: { kind: "driver-method", method: "cancelTurn" },
    description: "Active turn cancellation",
  },
  {
    name: "steering",
    lifecycle: "turn",
    enforcement: { kind: "driver-method", method: "steerTurn" },
    description: "Active turn steering",
  },
  {
    name: "close",
    lifecycle: "session",
    enforcement: { kind: "driver-method", method: "closeSession" },
    description: "Native Session shutdown",
  },
  {
    name: "cleanup",
    lifecycle: "session",
    enforcement: { kind: "invariant" },
    description: "Feature resource cleanup",
  },
] as const;
// RUNTIME_FEATURE_CATALOG_END

export type RuntimeFeatureName = (typeof RUNTIME_FEATURE_CATALOG)[number]["name"];
export type RuntimeFeatureLifecycle = (typeof RUNTIME_FEATURE_CATALOG)[number]["lifecycle"];
export type RuntimeDriverMethodName =
  | "canUse"
  | "listModels"
  | "readContextWindow"
  | "compactContext"
  | "cancelTurn"
  | "steerTurn"
  | "closeSession";
export type RuntimeFeatureEnforcement =
  | { readonly kind: "implementation" }
  | {
      readonly kind: "driver-method";
      readonly method: RuntimeDriverMethodName;
      readonly when?: "manual-compaction" | undefined;
    }
  | { readonly kind: "conformance" }
  | { readonly kind: "invariant" };
export type RuntimeFeatureEvidenceLevel = "materialized" | "discovered" | "executed";
export type RuntimeCompactionMode = "manual" | "events";

export interface RuntimeFeatureEvidenceRef {
  readonly probe: string;
  readonly level: RuntimeFeatureEvidenceLevel;
  readonly source: "conformance" | "fixture" | "real-probe" | "test";
  readonly runtimeVersion?: string | undefined;
  readonly platform?: string | undefined;
  readonly verifiedAt?: string | undefined;
}

interface RuntimeFeatureBase {
  readonly evidence?: readonly RuntimeFeatureEvidenceRef[] | undefined;
  readonly compactionModes?: readonly RuntimeCompactionMode[] | undefined;
}

export interface RuntimeFeatureSupported extends RuntimeFeatureBase {
  readonly status: "supported";
}

export interface RuntimeFeatureDegraded extends RuntimeFeatureBase {
  readonly status: "degraded";
  readonly reason: string;
}

export interface RuntimeFeatureUnsupported extends RuntimeFeatureBase {
  readonly status: "unsupported";
  readonly reason: string;
}

export interface RuntimeFeatureNotApplicable extends RuntimeFeatureBase {
  readonly status: "notApplicable";
  readonly reason: string;
}

export type RuntimeFeatureReadiness =
  | RuntimeFeatureSupported
  | RuntimeFeatureDegraded
  | RuntimeFeatureUnsupported
  | RuntimeFeatureNotApplicable;

/** The public status persisted on a RuntimeAdapter. */
export type RuntimeFeatureStatus = RuntimeFeatureReadiness;

export type RuntimePreparationPhase = "session" | "turn";

interface RuntimePreparationNodeBase<
  TPhase extends RuntimePreparationPhase,
  TOutput,
  TNeeds extends RuntimePreparationNeeds,
> {
  readonly phase: TPhase;
  readonly id?: string | undefined;
  readonly needs?: TNeeds | undefined;
  readonly prepare: TPhase extends "session"
    ? (
        context: RuntimeFeatureSessionPrepareContext,
        needs: RuntimePreparationOutputs<TNeeds>,
      ) => Promise<TOutput> | TOutput
    : (
        context: RuntimeFeatureTurnPrepareContext,
        needs: RuntimePreparationOutputs<TNeeds>,
      ) => Promise<TOutput> | TOutput;
}

export interface RuntimePreparationNode<
  TPhase extends RuntimePreparationPhase,
  TOutput,
  TNeeds extends RuntimePreparationNeeds = RuntimePreparationNeeds,
> extends RuntimePreparationNodeBase<TPhase, TOutput, TNeeds> {
  readonly kind: "preparation" | "feature";
}

export type RuntimePreparationNeeds = Readonly<Record<string, RuntimePreparationDependency>>;

export type RuntimePreparationOutputs<TNeeds extends RuntimePreparationNeeds | undefined> =
  TNeeds extends RuntimePreparationNeeds
    ? { readonly [TName in keyof TNeeds]: RuntimePreparationOutput<TNeeds[TName]> }
    : Record<never, never>;

export type RuntimePreparationOutput<TNode> = TNode extends {
  readonly prepare: (...args: never[]) => infer TOutput;
}
  ? Awaited<TOutput>
  : never;

export interface RuntimeNativeFeature<
  TReadiness extends RuntimeFeatureReadiness = RuntimeFeatureReadiness,
> extends RuntimeFeatureBase {
  readonly kind: "native";
  readonly readiness: TReadiness;
}

export interface RuntimeSessionFeature<
  TOutput,
  TNeeds extends RuntimePreparationNeeds = RuntimePreparationNeeds,
> extends RuntimePreparationNodeBase<"session", TOutput, TNeeds> {
  readonly kind: "feature";
  readonly readiness: Extract<
    RuntimeFeatureReadiness,
    { readonly status: "supported" | "degraded" }
  >;
}

export interface RuntimeTurnFeature<
  TOutput,
  TNeeds extends RuntimePreparationNeeds = RuntimePreparationNeeds,
> extends RuntimePreparationNodeBase<"turn", TOutput, TNeeds> {
  readonly kind: "feature";
  readonly readiness: Extract<
    RuntimeFeatureReadiness,
    { readonly status: "supported" | "degraded" }
  >;
}

export interface RuntimePreparationDependency {
  readonly phase: RuntimePreparationPhase;
  readonly id?: string | undefined;
  readonly needs?: object | undefined;
  readonly prepare: (...args: never[]) => unknown;
}

export interface RuntimeFeatureLifecycleDeclaration extends RuntimePreparationDependency {
  readonly kind: "feature";
  readonly readiness: Extract<
    RuntimeFeatureReadiness,
    { readonly status: "supported" | "degraded" }
  >;
}

export type RuntimeFeatureDeclaration = RuntimeNativeFeature | RuntimeFeatureLifecycleDeclaration;

export type RuntimeFeatureSet = {
  readonly [TName in RuntimeFeatureName]: RuntimeFeatureDeclaration;
};

export type RuntimeFeatureSnapshotSet = {
  readonly [TName in RuntimeFeatureName]: RuntimeFeatureStatus;
};

export type RuntimePreparedFeatureSet<TFeatures extends RuntimeFeatureSet> = Readonly<{
  [TName in keyof TFeatures]: RuntimePreparationOutput<TFeatures[TName]>;
}>;

type RuntimeReadinessOptions = RuntimeFeatureBase;
type EmptyRuntimeFeatureOptions = Record<never, never>;

export const runtimeFeature = {
  supported<const TOptions extends RuntimeReadinessOptions = EmptyRuntimeFeatureOptions>(
    options?: TOptions,
  ): RuntimeFeatureSupported & TOptions {
    return { status: "supported", ...(options ?? {}) } as RuntimeFeatureSupported & TOptions;
  },
  degraded<const TOptions extends RuntimeReadinessOptions = EmptyRuntimeFeatureOptions>(
    reason: string,
    options?: TOptions,
  ): RuntimeFeatureDegraded & TOptions {
    return {
      status: "degraded",
      reason: requireReason(reason),
      ...(options ?? {}),
    } as RuntimeFeatureDegraded & TOptions;
  },
  unsupported(reason: string): RuntimeFeatureUnsupported {
    return { status: "unsupported", reason: requireReason(reason) };
  },
  notApplicable(reason: string): RuntimeFeatureNotApplicable {
    return { status: "notApplicable", reason: requireReason(reason) };
  },
  native<const TReadiness extends RuntimeFeatureReadiness>(
    readiness: TReadiness,
  ): RuntimeNativeFeature<TReadiness> {
    return { kind: "native", readiness };
  },
  session<TOutput, const TNeeds extends RuntimePreparationNeeds = Record<never, never>>(
    options: Omit<RuntimeSessionFeature<TOutput, TNeeds>, "kind" | "phase">,
  ): RuntimeSessionFeature<TOutput, TNeeds> {
    return { kind: "feature", phase: "session", ...options };
  },
  turn<TOutput, const TNeeds extends RuntimePreparationNeeds = Record<never, never>>(
    options: Omit<RuntimeTurnFeature<TOutput, TNeeds>, "kind" | "phase">,
  ): RuntimeTurnFeature<TOutput, TNeeds> {
    return { kind: "feature", phase: "turn", ...options };
  },
};

export const runtimeStep = {
  session<TOutput, const TNeeds extends RuntimePreparationNeeds = Record<never, never>>(
    options: Omit<RuntimePreparationNode<"session", TOutput, TNeeds>, "kind" | "phase">,
  ): RuntimePreparationNode<"session", TOutput, TNeeds> {
    return { kind: "preparation", phase: "session", ...options };
  },
  turn<TOutput, const TNeeds extends RuntimePreparationNeeds = Record<never, never>>(
    options: Omit<RuntimePreparationNode<"turn", TOutput, TNeeds>, "kind" | "phase">,
  ): RuntimePreparationNode<"turn", TOutput, TNeeds> {
    return { kind: "preparation", phase: "turn", ...options };
  },
};

export function defineRuntimeFeatures<const TFeatures extends RuntimeFeatureSet>(
  features: TFeatures,
): TFeatures {
  validateRuntimeFeatures(features);
  return features;
}

export function validateRuntimeFeatures(features: RuntimeFeatureSet): void {
  const expected = new Set<RuntimeFeatureName>(
    RUNTIME_FEATURE_CATALOG.map((feature) => feature.name),
  );
  for (const name of Object.keys(features)) {
    if (!expected.has(name as RuntimeFeatureName)) {
      throw new Error(`Unknown Runtime feature slot: ${name}`);
    }
  }
  for (const name of expected) {
    const feature = features[name];
    const lifecycle = runtimeFeatureLifecycle(name);
    if (feature === undefined) {
      throw new Error(`Runtime feature declaration is missing mandatory slot: ${name}`);
    }
    const readiness = feature.readiness;
    if (
      (readiness.status === "degraded" ||
        readiness.status === "unsupported" ||
        readiness.status === "notApplicable") &&
      readiness.reason.trim() === ""
    ) {
      throw new Error(`Runtime feature ${name} requires a non-empty reason.`);
    }
    if (feature.kind === "native") continue;
    if (feature.phase !== lifecycle) {
      throw new Error(
        `Runtime feature ${name} has ${lifecycle} lifecycle and cannot declare a ${feature.phase} preparation.`,
      );
    }
    if (!isRuntimeFeatureEnabled(readiness)) {
      throw new Error(`Disabled Runtime feature ${name} must not declare a preparation.`);
    }
  }
  for (const { name, enforcement } of RUNTIME_FEATURE_CATALOG) {
    const feature = features[name];
    if (
      enforcement.kind === "implementation" &&
      isRuntimeFeatureEnabled(feature) &&
      feature.kind !== "feature"
    ) {
      throw new Error(
        `Enabled Runtime feature ${name} must provide a Core-owned preparation implementation.`,
      );
    }
  }
}

export function snapshotRuntimeFeatures(features: RuntimeFeatureSet): RuntimeFeatureSnapshotSet {
  return Object.freeze(
    Object.fromEntries(
      RUNTIME_FEATURE_CATALOG.map(({ name }) => [name, freezeReadiness(features[name].readiness)]),
    ) as RuntimeFeatureSnapshotSet,
  );
}

export function isRuntimeFeatureEnabled(
  feature: RuntimeFeatureStatus | RuntimeFeatureDeclaration,
): boolean {
  const readiness = "readiness" in feature ? feature.readiness : feature;
  return readiness.status === "supported" || readiness.status === "degraded";
}

export function deriveRuntimeAdapterCapabilities(
  features: RuntimeFeatureSet | RuntimeFeatureSnapshotSet,
  placement: RuntimeAdapterPlacementCapabilities | undefined,
): RuntimeAdapterCapabilities {
  const compaction = features.compaction;
  const compactionModes = new Set(
    ("readiness" in compaction ? compaction.readiness : compaction).compactionModes ?? [],
  );
  const targets =
    placement?.targets === undefined ? undefined : Object.freeze([...placement.targets]);
  const executionLocations =
    placement?.executionLocations === undefined
      ? undefined
      : Object.freeze([...placement.executionLocations]);
  return Object.freeze({
    ...(targets === undefined ? {} : { targets }),
    ...(executionLocations === undefined ? {} : { executionLocations }),
    supportsStreaming: isRuntimeFeatureEnabled(features.textStreaming),
    supportsAbort: isRuntimeFeatureEnabled(features.cancellation),
    supportsMcp: isRuntimeFeatureEnabled(features.mcp),
    supportsResume: isRuntimeFeatureEnabled(features.resume),
    supportsSteer: isRuntimeFeatureEnabled(features.steering),
    supportsCancel: isRuntimeFeatureEnabled(features.cancellation),
    supportsClose: isRuntimeFeatureEnabled(features.close),
    supportsContextWindowInspection: isRuntimeFeatureEnabled(features.contextWindow),
    supportsManualCompaction: isRuntimeFeatureEnabled(compaction) && compactionModes.has("manual"),
    supportsContextCompactionEvents:
      isRuntimeFeatureEnabled(compaction) && compactionModes.has("events"),
  });
}

export function runtimeFeatureLifecycle(name: RuntimeFeatureName): RuntimeFeatureLifecycle {
  return RUNTIME_FEATURE_CATALOG.find((feature) => feature.name === name)!.lifecycle;
}

function freezeReadiness(readiness: RuntimeFeatureReadiness): RuntimeFeatureStatus {
  return Object.freeze({
    ...readiness,
    ...(readiness.evidence === undefined
      ? {}
      : {
          evidence: Object.freeze(readiness.evidence.map((entry) => Object.freeze({ ...entry }))),
        }),
    ...(readiness.compactionModes === undefined
      ? {}
      : { compactionModes: Object.freeze([...readiness.compactionModes]) }),
  });
}

function requireReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized === "") throw new Error("Runtime feature reason must not be empty.");
  return normalized;
}
