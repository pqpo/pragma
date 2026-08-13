import type {
  RuntimeAdapterCapabilities,
  RuntimeAdapterPlacementCapabilities,
} from "./runtime-adapter.ts";
import type {
  RuntimeFeatureSessionPrepareContext,
  RuntimeFeatureTurnPrepareContext,
} from "./driver.ts";

// RUNTIME_FEATURE_CATALOG_START
export const RUNTIME_FEATURE_CATALOG = [
  { name: "availability", lifecycle: "driver", description: "Runtime availability probing" },
  {
    name: "authentication",
    lifecycle: "driver",
    description: "Runtime authentication setup and validation",
  },
  { name: "modelDiscovery", lifecycle: "driver", description: "Model catalog discovery" },
  {
    name: "modelSelection",
    lifecycle: "turn",
    description: "Per-Session or per-turn model selection",
  },
  { name: "thinking", lifecycle: "turn", description: "Thinking or reasoning level selection" },
  { name: "freshSession", lifecycle: "session", description: "Fresh native Session creation" },
  { name: "resume", lifecycle: "session", description: "Native Session restoration" },
  { name: "systemPrompt", lifecycle: "session", description: "System prompt delivery" },
  {
    name: "startupMessages",
    lifecycle: "session",
    description: "Startup message delivery and reinjection",
  },
  { name: "textStreaming", lifecycle: "turn", description: "Ordered text streaming" },
  { name: "reasoningStreaming", lifecycle: "turn", description: "Ordered reasoning streaming" },
  {
    name: "nativeToolLifecycle",
    lifecycle: "turn",
    description: "Native tool start, update, and completion events",
  },
  { name: "mcp", lifecycle: "session", description: "MCP tool registration and execution" },
  { name: "permissions", lifecycle: "session", description: "Tool permission policy and approval" },
  { name: "userInteraction", lifecycle: "turn", description: "Durable human interaction" },
  { name: "skills", lifecycle: "session", description: "Skill materialization and invocation" },
  { name: "attachmentImage", lifecycle: "turn", description: "Image attachments" },
  { name: "attachmentFile", lifecycle: "turn", description: "File attachments" },
  { name: "attachmentDirectory", lifecycle: "turn", description: "Directory attachments" },
  { name: "usage", lifecycle: "turn", description: "Token usage observation" },
  { name: "contextWindow", lifecycle: "driver", description: "Context window inspection" },
  {
    name: "compaction",
    lifecycle: "session",
    description: "Context compaction and compaction events",
  },
  { name: "cancellation", lifecycle: "turn", description: "Active turn cancellation" },
  { name: "steering", lifecycle: "turn", description: "Active turn steering" },
  { name: "close", lifecycle: "session", description: "Native Session shutdown" },
  { name: "cleanup", lifecycle: "session", description: "Feature resource cleanup" },
] as const;
// RUNTIME_FEATURE_CATALOG_END

export type RuntimeFeatureName = (typeof RUNTIME_FEATURE_CATALOG)[number]["name"];
export type RuntimeFeatureLifecycle = (typeof RUNTIME_FEATURE_CATALOG)[number]["lifecycle"];
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

export type RuntimeFeatureStatus =
  | RuntimeFeatureSupported
  | RuntimeFeatureDegraded
  | RuntimeFeatureUnsupported
  | RuntimeFeatureNotApplicable;

export interface RuntimeFeatureDeclarationHooks {
  readonly prepareSession?:
    ((context: RuntimeFeatureSessionPrepareContext) => Promise<unknown> | unknown) | undefined;
  readonly prepareTurn?:
    ((context: RuntimeFeatureTurnPrepareContext) => Promise<unknown> | unknown) | undefined;
}

export type RuntimeFeatureDeclaration = RuntimeFeatureStatus & RuntimeFeatureDeclarationHooks;

export type RuntimeFeatureSet = {
  readonly [TName in RuntimeFeatureName]: RuntimeFeatureDeclaration;
};

export type RuntimeFeatureSnapshotSet = {
  readonly [TName in RuntimeFeatureName]: RuntimeFeatureStatus;
};

type RuntimeFeatureOptions = RuntimeFeatureBase & RuntimeFeatureDeclarationHooks;
type EmptyRuntimeFeatureOptions = Record<never, never>;

export const runtimeFeature = {
  supported<const TOptions extends RuntimeFeatureOptions = EmptyRuntimeFeatureOptions>(
    options?: TOptions,
  ): RuntimeFeatureSupported & TOptions {
    return { status: "supported", ...(options ?? {}) } as RuntimeFeatureSupported & TOptions;
  },
  degraded<const TOptions extends RuntimeFeatureOptions = EmptyRuntimeFeatureOptions>(
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
    if (
      (feature.status === "degraded" ||
        feature.status === "unsupported" ||
        feature.status === "notApplicable") &&
      feature.reason.trim() === ""
    ) {
      throw new Error(`Runtime feature ${name} requires a non-empty reason.`);
    }
    if (
      !isRuntimeFeatureEnabled(feature) &&
      (feature.prepareSession !== undefined || feature.prepareTurn !== undefined)
    ) {
      throw new Error(`Disabled Runtime feature ${name} must not declare lifecycle hooks.`);
    }
    if (feature.prepareSession !== undefined && lifecycle !== "session") {
      throw new Error(
        `Runtime feature ${name} has ${lifecycle} lifecycle and cannot declare prepareSession().`,
      );
    }
    if (feature.prepareTurn !== undefined && lifecycle !== "turn") {
      throw new Error(
        `Runtime feature ${name} has ${lifecycle} lifecycle and cannot declare prepareTurn().`,
      );
    }
    if (
      feature.status === "supported" &&
      (name === "mcp" || name === "permissions" || name === "skills") &&
      feature.prepareSession === undefined
    ) {
      throw new Error(
        `Supported Runtime feature ${name} must participate in Core-owned Session preparation.`,
      );
    }
  }
}

export function snapshotRuntimeFeatures(features: RuntimeFeatureSet): RuntimeFeatureSnapshotSet {
  return Object.freeze(
    Object.fromEntries(
      RUNTIME_FEATURE_CATALOG.map(({ name }) => {
        const status = Object.fromEntries(
          Object.entries(features[name])
            .filter(([key]) => key !== "prepareSession" && key !== "prepareTurn")
            .map(([key, value]) => [
              key,
              key === "evidence"
                ? Object.freeze(
                    (value as readonly RuntimeFeatureEvidenceRef[]).map((entry) =>
                      Object.freeze({ ...entry }),
                    ),
                  )
                : key === "compactionModes"
                  ? Object.freeze([...(value as readonly RuntimeCompactionMode[])])
                  : value,
            ]),
        ) as unknown as RuntimeFeatureStatus;
        return [name, Object.freeze(status)];
      }),
    ) as RuntimeFeatureSnapshotSet,
  );
}

export function isRuntimeFeatureEnabled(feature: RuntimeFeatureStatus): boolean {
  return feature.status === "supported" || feature.status === "degraded";
}

export function deriveRuntimeAdapterCapabilities(
  features: RuntimeFeatureSet,
  placement: RuntimeAdapterPlacementCapabilities | undefined,
): RuntimeAdapterCapabilities {
  const compaction = features.compaction;
  const compactionModes = new Set(compaction.compactionModes ?? []);
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

function requireReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized === "") throw new Error("Runtime feature reason must not be empty.");
  return normalized;
}
