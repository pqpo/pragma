import {
  RUNTIME_FEATURE_CATALOG,
  defineRuntimeFeatures,
  runtimeFeature,
  type RuntimeCompactionMode,
  type RuntimeFeatureDeclaration,
  type RuntimeFeatureName,
  type RuntimeFeatureSet,
} from "../runtime/features.ts";
import {
  assertRuntimeConformance,
  type RuntimeConformanceObservation,
} from "../runtime/conformance.ts";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.ts";
import {
  defineRuntimeDriver,
  type DefineRuntimeDriverOptions,
  type RuntimeDriver,
} from "../runtime/driver.ts";

export interface RuntimeConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface RuntimeConformanceCaseOptions {
  readonly createRuntime: () => RuntimeAdapter | Promise<RuntimeAdapter>;
  readonly createObservation?:
    | ((
        runtime: RuntimeAdapter,
      ) => RuntimeConformanceObservation | Promise<RuntimeConformanceObservation>)
    | undefined;
}

export function createRuntimeConformanceCases(
  options: RuntimeConformanceCaseOptions,
): readonly RuntimeConformanceCase[] {
  const declaration: RuntimeConformanceCase = {
    name: "declares every mandatory feature and derives capabilities",
    run: async () => assertRuntimeConformance(await options.createRuntime()),
  };
  if (options.createObservation === undefined) return [declaration];
  return [
    declaration,
    {
      name: "preserves streaming, tool, output, and persistence invariants",
      run: async () => {
        const runtime = await options.createRuntime();
        assertRuntimeConformance(runtime, await options.createObservation!(runtime));
      },
    },
  ];
}

export function createRuntimeTestFeatures(
  options: {
    readonly enabled?: readonly RuntimeFeatureName[] | undefined;
    readonly overrides?: Partial<Record<RuntimeFeatureName, RuntimeFeatureDeclaration>> | undefined;
    readonly compactionModes?: readonly RuntimeCompactionMode[] | undefined;
  } = {},
): RuntimeFeatureSet {
  const enabled = new Set<RuntimeFeatureName>([
    "freshSession",
    "systemPrompt",
    "startupMessages",
    "textStreaming",
    "cleanup",
    ...(options.enabled ?? []),
  ]);
  const features = Object.fromEntries(
    RUNTIME_FEATURE_CATALOG.map(({ name }) => [
      name,
      enabled.has(name)
        ? runtimeFeature.degraded("Enabled by an in-memory Runtime test fixture.", {
            ...(name === "compaction"
              ? { compactionModes: options.compactionModes ?? ["manual"] }
              : {}),
          })
        : runtimeFeature.notApplicable("Not exercised by this Runtime test fixture."),
    ]),
  ) as RuntimeFeatureSet;
  return defineRuntimeFeatures({ ...features, ...options.overrides });
}

export function defineRuntimeTestDriver<TNativeEvent, TNativeSession>(
  driver: Omit<RuntimeDriver<TNativeEvent, TNativeSession>, "features"> & {
    readonly features?: RuntimeFeatureSet | undefined;
  },
  options: DefineRuntimeDriverOptions = {},
): RuntimeAdapter {
  const enabled: RuntimeFeatureName[] = [];
  if (driver.canUse !== undefined) enabled.push("availability");
  if (driver.listModels !== undefined) enabled.push("modelDiscovery");
  if (driver.restoreSession !== undefined) enabled.push("resume");
  if (driver.readContextWindow !== undefined) enabled.push("contextWindow");
  if (driver.compactContext !== undefined) enabled.push("compaction");
  if (driver.cancelTurn !== undefined) enabled.push("cancellation");
  if (driver.steerTurn !== undefined) enabled.push("steering");
  if (driver.closeSession !== undefined) enabled.push("close");
  return defineRuntimeDriver(
    {
      ...driver,
      features:
        driver.features ??
        createRuntimeTestFeatures({
          enabled,
          compactionModes: driver.compactContext === undefined ? [] : ["manual"],
        }),
    },
    options,
  );
}
