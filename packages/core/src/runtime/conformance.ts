import type { RuntimeAdapter } from "./runtime-adapter.ts";
import {
  RUNTIME_FEATURE_CATALOG,
  deriveRuntimeAdapterCapabilities,
  isRuntimeFeatureEnabled,
  type RuntimeFeatureName,
} from "./features.ts";
import type { RuntimeProbeEvidence } from "./probe-evidence.ts";
import { RuntimeProbeEvidenceSchema } from "./probe-evidence.ts";
import type { RuntimeStreamEvent } from "./stream-events.ts";

export interface RuntimeConformanceFailure {
  readonly code: string;
  readonly message: string;
  readonly feature?: RuntimeFeatureName | undefined;
}

export interface RuntimeConformanceObservation {
  readonly events: readonly RuntimeStreamEvent[];
  readonly outputText?: string | undefined;
  readonly requiredFeatures?: readonly RuntimeFeatureName[] | undefined;
  readonly expectedToolNames?: readonly string[] | undefined;
  readonly expectedOutputMarkers?: readonly string[] | undefined;
  readonly structuredOutputValidated?: boolean | undefined;
  readonly ownerPersistenceValidated?: boolean | undefined;
  readonly evidence?: RuntimeProbeEvidence | undefined;
}

export function inspectRuntimeDeclarationConformance(
  runtime: RuntimeAdapter,
): readonly RuntimeConformanceFailure[] {
  const failures: RuntimeConformanceFailure[] = [];
  for (const { name } of RUNTIME_FEATURE_CATALOG) {
    const feature = runtime.features[name];
    if (feature === undefined) {
      failures.push({
        code: "feature.missing",
        feature: name,
        message: `Missing feature ${name}.`,
      });
      continue;
    }
    if (feature.status === "supported") {
      const evidenceLevels = new Set(feature.evidence?.map(({ level }) => level) ?? []);
      if (!evidenceLevels.has("executed")) {
        failures.push({
          code: "feature.supported_without_execution_evidence",
          feature: name,
          message: `Feature ${name} is supported but has no executed evidence reference.`,
        });
      }
      if (
        !feature.evidence?.some(
          ({ level, source }) => level === "executed" && source === "real-probe",
        )
      ) {
        failures.push({
          code: "feature.supported_without_real_probe",
          feature: name,
          message: `Feature ${name} is supported but has no executed real-Runtime probe reference.`,
        });
      }
      if (name === "mcp" || name === "skills") {
        for (const level of ["materialized", "discovered", "executed"] as const) {
          if (!evidenceLevels.has(level)) {
            failures.push({
              code: "feature.supported_without_staged_evidence",
              feature: name,
              message: `Feature ${name} is supported but has no ${level} evidence reference.`,
            });
          }
        }
      }
    }
  }
  const expected = deriveRuntimeAdapterCapabilities(
    runtime.features,
    runtime.descriptor.capabilities,
  );
  for (const key of [
    "supportsStreaming",
    "supportsAbort",
    "supportsMcp",
    "supportsResume",
    "supportsSteer",
    "supportsCancel",
    "supportsClose",
    "supportsContextWindowInspection",
    "supportsManualCompaction",
    "supportsContextCompactionEvents",
  ] as const) {
    if (runtime.descriptor.capabilities?.[key] !== expected[key]) {
      failures.push({
        code: "capability.projection_mismatch",
        message: `Capability ${key} is not the projection of Runtime features.`,
      });
    }
  }
  return failures;
}

export function inspectRuntimeObservationConformance(
  runtime: RuntimeAdapter,
  observation: RuntimeConformanceObservation,
): readonly RuntimeConformanceFailure[] {
  const failures: RuntimeConformanceFailure[] = [...inspectRuntimeDeclarationConformance(runtime)];
  const events = observation.events;
  const eventIds = new Set<string>();
  let previousSequence = -1;
  for (const event of events) {
    if (eventIds.has(event.eventId)) {
      failures.push({
        code: "stream.duplicate_event",
        message: `Duplicate eventId ${event.eventId}.`,
      });
    }
    eventIds.add(event.eventId);
    if (event.sequence <= previousSequence) {
      failures.push({
        code: "stream.sequence_order",
        message: `Event sequence ${event.sequence} is not strictly increasing.`,
      });
    }
    previousSequence = event.sequence;
  }
  const terminalIndexes = events.flatMap((event, index) =>
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
      ? [index]
      : [],
  );
  if (events.length > 0 && events[0]?.type !== "run.started") {
    failures.push({ code: "stream.run_start_order", message: "run.started must be first." });
  }
  if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
    failures.push({
      code: "stream.terminal_order",
      message: "Exactly one terminal run event must be last.",
    });
  }
  if (isRuntimeFeatureEnabled(runtime.features.textStreaming)) {
    const deltaIndex = events.findIndex(
      (event) =>
        event.type === "message.delta" &&
        event.payload.role === "assistant" &&
        event.payload.contentType === "text",
    );
    const completedIndex = events.findIndex(
      (event) =>
        event.type === "message.completed" &&
        event.payload.role === "assistant" &&
        event.payload.contentType === "text",
    );
    if (deltaIndex < 0 || completedIndex <= deltaIndex) {
      failures.push({
        code: "stream.text_lifecycle",
        feature: "textStreaming",
        message: "Text streaming must emit delta before completed.",
      });
    }
    inspectTextSnapshotConsistency(events, observation.outputText, failures);
  }
  inspectToolLifecycle(events, failures);
  for (const toolName of observation.expectedToolNames ?? []) {
    if (
      !events.some(
        (event) =>
          event.type === "tool.completed" &&
          runtimeToolNameMatches(event.payload.toolName, toolName),
      )
    ) {
      failures.push({
        code: "tool.expected_not_executed",
        feature: isExpectedMcpTool(toolName) ? "mcp" : "nativeToolLifecycle",
        message: `Expected tool ${toolName} did not complete.`,
      });
    }
  }
  for (const marker of observation.expectedOutputMarkers ?? []) {
    if (!observation.outputText?.includes(marker)) {
      failures.push({
        code: "output.marker_missing",
        message: `Expected output marker ${marker} is missing.`,
      });
    }
  }
  if (observation.structuredOutputValidated === false) {
    failures.push({
      code: "invariant.structured_output",
      message: "Structured output validation is an unconditional Runtime invariant.",
    });
  }
  if (observation.ownerPersistenceValidated === false) {
    failures.push({
      code: "invariant.owner_persistence",
      message: "Runtime Session owner persistence is an unconditional invariant.",
    });
  }
  for (const feature of observation.requiredFeatures ?? []) {
    if (!isRuntimeFeatureEnabled(runtime.features[feature])) {
      failures.push({
        code: "probe.required_feature_disabled",
        feature,
        message: `Probe requires disabled feature ${feature}.`,
      });
    }
  }
  if (observation.evidence !== undefined) {
    failures.push(...inspectRuntimeProbeEvidenceConformance(runtime, observation.evidence));
  }
  return failures;
}

function inspectTextSnapshotConsistency(
  events: readonly RuntimeStreamEvent[],
  outputText: string | undefined,
  failures: RuntimeConformanceFailure[],
): void {
  let streamed = "";
  let lastCompletedText: string | undefined;
  for (const event of events) {
    if (
      event.type === "message.delta" &&
      event.payload.role === "assistant" &&
      event.payload.contentType === "text"
    ) {
      streamed += event.payload.delta;
      continue;
    }
    if (
      event.type !== "message.completed" ||
      event.payload.role !== "assistant" ||
      event.payload.contentType !== "text"
    ) {
      continue;
    }
    const completedText = event.payload.text;
    if (streamed !== "" && completedText !== undefined && completedText !== streamed) {
      failures.push({
        code: "stream.snapshot_mismatch",
        feature: "textStreaming",
        message:
          "The completed text snapshot differs from the preceding deltas and may duplicate output.",
      });
    }
    lastCompletedText = completedText;
    streamed = "";
  }
  if (
    outputText !== undefined &&
    lastCompletedText !== undefined &&
    outputText !== lastCompletedText
  ) {
    failures.push({
      code: "stream.output_mismatch",
      feature: "textStreaming",
      message: "The Runtime result differs from the final completed text snapshot.",
    });
  }
}

export function inspectRuntimeProbeEvidenceConformance(
  runtime: RuntimeAdapter,
  evidence: RuntimeProbeEvidence,
): readonly RuntimeConformanceFailure[] {
  const parsed = RuntimeProbeEvidenceSchema.parse(evidence);
  const failures: RuntimeConformanceFailure[] = [];
  if (
    parsed.runtime.id !== runtime.descriptor.id ||
    parsed.runtime.kind !== runtime.descriptor.kind
  ) {
    failures.push({
      code: "evidence.runtime_mismatch",
      message: `Evidence belongs to ${parsed.runtime.id}/${parsed.runtime.kind}, not ${runtime.descriptor.id}/${runtime.descriptor.kind}.`,
    });
  }
  for (const assertion of parsed.assertions) {
    if (!isRuntimeFeatureEnabled(runtime.features[assertion.feature])) {
      failures.push({
        code: "evidence.feature_disabled",
        feature: assertion.feature,
        message: `Evidence targets disabled feature ${assertion.feature}.`,
      });
    }
    if (assertion.status === "failed") {
      failures.push({
        code: "evidence.assertion_failed",
        feature: assertion.feature,
        message: `Evidence assertion ${assertion.id} failed: ${assertion.message}`,
      });
    }
  }
  const stagedFeatures = (["mcp", "skills"] as const).filter(
    (feature) =>
      parsed.probe.id === feature ||
      parsed.assertions.some((assertion) => assertion.feature === feature),
  );
  for (const stagedFeature of stagedFeatures) {
    for (const stage of ["materialized", "discovered", "executed"] as const) {
      if (
        !parsed.assertions.some(
          (assertion) =>
            assertion.feature === stagedFeature &&
            assertion.stage === stage &&
            assertion.status === "passed",
        )
      ) {
        failures.push({
          code: "evidence.stage_missing",
          feature: stagedFeature,
          message: `${stagedFeature} evidence has no passing ${stage} assertion.`,
        });
      }
    }
  }
  return failures;
}

export function assertRuntimeConformance(
  runtime: RuntimeAdapter,
  observation?: RuntimeConformanceObservation,
): void {
  const failures =
    observation === undefined
      ? inspectRuntimeDeclarationConformance(runtime)
      : inspectRuntimeObservationConformance(runtime, observation);
  if (failures.length > 0) {
    throw new Error(
      `Runtime ${runtime.descriptor.id} failed conformance:\n${failures
        .map((failure) => `- [${failure.code}] ${failure.message}`)
        .join("\n")}`,
    );
  }
}

function inspectToolLifecycle(
  events: readonly RuntimeStreamEvent[],
  failures: RuntimeConformanceFailure[],
): void {
  const states = new Map<string, "started" | "terminal">();
  for (const event of events) {
    if (!event.type.startsWith("tool.")) continue;
    if (!("toolCallId" in event.payload)) continue;
    const toolCallId = event.payload.toolCallId;
    const state = states.get(toolCallId);
    if (event.type === "tool.started") {
      if (state !== undefined) {
        failures.push({
          code: "tool.duplicate_start",
          feature: "nativeToolLifecycle",
          message: `Tool ${toolCallId} started more than once.`,
        });
      }
      states.set(toolCallId, "started");
    } else if (event.type === "tool.delta") {
      if (state !== "started") {
        failures.push({
          code: "tool.delta_without_start",
          feature: "nativeToolLifecycle",
          message: `Tool ${toolCallId} emitted delta before start.`,
        });
      }
    } else if (event.type === "tool.completed" || event.type === "tool.failed") {
      if (state !== "started") {
        failures.push({
          code: "tool.terminal_without_start",
          feature: "nativeToolLifecycle",
          message: `Tool ${toolCallId} terminated without one active start.`,
        });
      }
      states.set(toolCallId, "terminal");
    }
  }
  for (const [toolCallId, state] of states) {
    if (state !== "terminal") {
      failures.push({
        code: "tool.missing_terminal",
        feature: "nativeToolLifecycle",
        message: `Tool ${toolCallId} has no terminal event.`,
      });
    }
  }
}

function runtimeToolNameMatches(actual: string, expected: string): boolean {
  return (
    actual === expected ||
    actual.endsWith(`__${expected}`) ||
    actual.endsWith(`/${expected}`) ||
    actual.endsWith(`_${expected}`)
  );
}

function isExpectedMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp_") || toolName.includes("expert_context");
}
