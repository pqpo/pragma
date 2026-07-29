export const RUNTIME_CONTEXT_COMPACTION_STAGES = {
  started: "context.compaction.started",
  completed: "context.compaction.completed",
  failed: "context.compaction.failed",
} as const;

export type RuntimeContextCompactionStage =
  (typeof RUNTIME_CONTEXT_COMPACTION_STAGES)[keyof typeof RUNTIME_CONTEXT_COMPACTION_STAGES];

export type RuntimeContextCompactionTrigger = "auto" | "manual" | "overflow" | "unknown";

export interface RuntimeContextCompactionProgressData {
  readonly operationId: string;
  readonly trigger: RuntimeContextCompactionTrigger;
  readonly runtimeId: string;
  readonly errorMessage?: string | undefined;
}

export function isRuntimeContextCompactionStage(
  value: unknown,
): value is RuntimeContextCompactionStage {
  return (
    typeof value === "string" &&
    Object.values(RUNTIME_CONTEXT_COMPACTION_STAGES).includes(
      value as RuntimeContextCompactionStage,
    )
  );
}

export function readRuntimeContextCompactionProgressData(
  value: unknown,
): RuntimeContextCompactionProgressData | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const operationId = record["operationId"];
  const trigger = record["trigger"];
  const runtimeId = record["runtimeId"];
  const errorMessage = record["errorMessage"];
  if (
    typeof operationId !== "string" ||
    operationId === "" ||
    !isRuntimeContextCompactionTrigger(trigger) ||
    typeof runtimeId !== "string" ||
    runtimeId === "" ||
    (errorMessage !== undefined && typeof errorMessage !== "string")
  ) {
    return undefined;
  }
  return {
    operationId,
    trigger,
    runtimeId,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function isRuntimeContextCompactionTrigger(
  value: unknown,
): value is RuntimeContextCompactionTrigger {
  return value === "auto" || value === "manual" || value === "overflow" || value === "unknown";
}
