import { createIntegrationError, type MissionCommand } from "@pragma/shared/integration";

import { isPermanentMissionEventType } from "./pinned-binding.ts";
import type { MissionAggregateState, MissionEvent, MissionOperationProjection } from "./schemas.ts";

export interface MissionRetentionLimits {
  readonly maxCount: number;
  readonly maxBytes: number;
}

export interface MissionRetentionOptions {
  readonly events?: Partial<MissionRetentionLimits> | undefined;
  readonly terminalCommands?: Partial<MissionRetentionLimits> | undefined;
}

export interface MissionRetentionPolicy {
  readonly events: MissionRetentionLimits;
  readonly terminalCommands: MissionRetentionLimits;
}

/**
 * The defaults are frozen from the local M8 benchmark in
 * `packages/local-host/test/retention.test.ts`:
 *
 * - event JSONL records: 291..4,498 bytes for the representative fixtures;
 * - command Inbox records: 4,700..4,955 bytes for 4 KiB send/respond inputs.
 *
 * Count remains the first protection for a high-volume stream, while the byte
 * limit bounds an unusually large event or command payload.  Mandatory
 * identity and non-terminal records are retained outside these terminal-tail
 * budgets so an active Mission can never be silently discarded.
 */
export const DEFAULT_MISSION_RETENTION_POLICY: MissionRetentionPolicy = {
  events: { maxCount: 2_000, maxBytes: 4 * 1024 * 1024 },
  terminalCommands: { maxCount: 1_000, maxBytes: 2 * 1024 * 1024 },
};

const STATUS_EVENT_TYPES = new Set([
  "mission.created",
  "run.accepted",
  "run.started",
  "run.progress",
  "run.input_required",
  "run.succeeded",
  "run.failed",
  "run.interrupted",
  "human.interaction.requested",
  "human.interaction.resolved",
]);

export interface MissionRetentionPlan {
  readonly retainedEvents: readonly MissionEvent[];
  readonly retainedCommands: readonly MissionCommand[];
  readonly retainedOperations: Readonly<Record<string, MissionOperationProjection>>;
  readonly removedEventCount: number;
  readonly removedCommandCount: number;
  readonly removedOperationCount: number;
  readonly changed: boolean;
}

export interface MissionRetentionReport {
  readonly compacted: boolean;
  readonly retainedEventCount: number;
  readonly retainedCommandCount: number;
  readonly retainedOperationCount: number;
  readonly removedEventCount: number;
  readonly removedCommandCount: number;
  readonly removedOperationCount: number;
}

export function resolveMissionRetentionPolicy(
  options: MissionRetentionOptions | undefined,
): MissionRetentionPolicy {
  const events = resolveLimits(options?.events, DEFAULT_MISSION_RETENTION_POLICY.events, "events");
  const terminalCommands = resolveLimits(
    options?.terminalCommands,
    DEFAULT_MISSION_RETENTION_POLICY.terminalCommands,
    "terminalCommands",
  );
  return { events, terminalCommands };
}

export function planMissionRetention(input: {
  readonly events: readonly MissionEvent[];
  readonly commands: readonly MissionCommand[];
  readonly state: MissionAggregateState;
  readonly policy: MissionRetentionPolicy;
}): MissionRetentionPlan {
  const commandById = new Map(input.commands.map((command) => [command.commandId, command]));
  const activeExecutionIds = findActiveExecutionIds(input.events);
  const latestStatusEventId = findLatestStatusEventId(input.events);
  const retainedEvents = selectRetainedItems(
    input.events,
    (event) => isMandatoryEvent(event, commandById, activeExecutionIds, latestStatusEventId),
    input.policy.events,
    (event) => serializedBytes(event),
  );

  const commandByRequestId = new Map(
    input.commands.map((command) => [command.request.requestId, command]),
  );
  const operationByRequestId = new Map(Object.entries(input.state.operations));
  const requestIds = [
    ...new Set([...commandByRequestId.keys(), ...operationByRequestId.keys()]),
  ].toSorted((left, right) => {
    const leftAt =
      commandByRequestId.get(left)?.createdAt ?? operationByRequestId.get(left)?.createdAt;
    const rightAt =
      commandByRequestId.get(right)?.createdAt ?? operationByRequestId.get(right)?.createdAt;
    return (leftAt ?? "").localeCompare(rightAt ?? "");
  });
  const retainedRequestIds = selectRetainedItems(
    [...requestIds],
    (requestId) => {
      const command = commandByRequestId.get(requestId);
      const operation = operationByRequestId.get(requestId);
      return isNonTerminalCommand(command) || isNonTerminalOperation(operation);
    },
    input.policy.terminalCommands,
    (requestId) =>
      serializedBytes(commandByRequestId.get(requestId)) +
      serializedBytes(operationByRequestId.get(requestId)),
  );
  const retainedRequestIdSet = new Set(retainedRequestIds);
  const retainedCommands = input.commands.filter((command) =>
    retainedRequestIdSet.has(command.request.requestId),
  );
  const retainedOperations = Object.fromEntries(
    Object.entries(input.state.operations).filter(([requestId]) =>
      retainedRequestIdSet.has(requestId),
    ),
  ) as Record<string, MissionOperationProjection>;

  const removedOperationCount =
    Object.keys(input.state.operations).length - Object.keys(retainedOperations).length;
  const changed =
    retainedEvents.length !== input.events.length ||
    retainedCommands.length !== input.commands.length ||
    removedOperationCount > 0;
  return {
    retainedEvents,
    retainedCommands,
    retainedOperations,
    removedEventCount: input.events.length - retainedEvents.length,
    removedCommandCount: input.commands.length - retainedCommands.length,
    removedOperationCount,
    changed,
  };
}

export function retentionReport(plan: MissionRetentionPlan): MissionRetentionReport {
  return {
    compacted: plan.changed,
    retainedEventCount: plan.retainedEvents.length,
    retainedCommandCount: plan.retainedCommands.length,
    retainedOperationCount: Object.keys(plan.retainedOperations).length,
    removedEventCount: plan.removedEventCount,
    removedCommandCount: plan.removedCommandCount,
    removedOperationCount: plan.removedOperationCount,
  };
}

/**
 * Avoid a full retention plan for the normal path while keeping the trigger
 * conservative.  The planner still decides which records are actually
 * removable; this predicate only answers whether any configured budget might
 * have been crossed.
 */
export function exceedsMissionRetentionBudget(input: {
  readonly events: readonly MissionEvent[];
  readonly commands: readonly MissionCommand[];
  readonly state: MissionAggregateState;
  readonly policy: MissionRetentionPolicy;
}): boolean {
  const eventBytes = input.events.reduce((total, event) => total + serializedBytes(event), 0);
  if (
    input.events.length > input.policy.events.maxCount ||
    eventBytes > input.policy.events.maxBytes
  )
    return true;

  const commandBytes = input.commands.reduce(
    (total, command) => total + serializedBytes(command),
    0,
  );
  const operationBytes = Object.values(input.state.operations).reduce(
    (total, operation) => total + serializedBytes(operation),
    0,
  );
  return (
    input.commands.length > input.policy.terminalCommands.maxCount ||
    Object.keys(input.state.operations).length > input.policy.terminalCommands.maxCount ||
    commandBytes + operationBytes > input.policy.terminalCommands.maxBytes
  );
}

export function isTerminalMissionCommandState(state: MissionCommand["state"]): boolean {
  return state === "applied" || state === "rejected" || state === "expired";
}

export function isTerminalMissionOperationState(
  state: MissionOperationProjection["state"],
): boolean {
  return state === "applied" || state === "rejected" || state === "expired" || state === "failed";
}

export function isTerminalMissionEventType(type: string): boolean {
  return type === "run.succeeded" || type === "run.failed" || type === "run.interrupted";
}

function resolveLimits(
  options: Partial<MissionRetentionLimits> | undefined,
  defaults: MissionRetentionLimits,
  name: string,
): MissionRetentionLimits {
  const maxCount = options?.maxCount ?? defaults.maxCount;
  const maxBytes = options?.maxBytes ?? defaults.maxBytes;
  if (!isPositiveSafeInteger(maxCount) || !isPositiveSafeInteger(maxBytes)) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: `Mission retention ${name} limits must be positive safe integers.`,
    });
  }
  return { maxCount, maxBytes };
}

function isMandatoryEvent(
  event: MissionEvent,
  commandById: ReadonlyMap<string, MissionCommand>,
  activeExecutionIds: ReadonlySet<string>,
  latestStatusEventId: string | undefined,
): boolean {
  if (isPermanentMissionEventType(event.type) || event.type === "mission.created") return true;
  // run.accepted contains the original request identity used by the M7
  // project backfill. Keep it even after the execution reaches a terminal
  // state; the bounded tail is not a substitute for this recovery anchor.
  if (event.type === "run.accepted") return true;
  const commandId = readString(event.data["commandId"]);
  const command = commandId === undefined ? undefined : commandById.get(commandId);
  if (isNonTerminalCommand(command)) return true;

  const executionId = readString(event.data["executionId"]);
  if (executionId !== undefined && activeExecutionIds.has(executionId)) return true;

  // Preserve one latest lifecycle state anchor after transient progress/output
  // records have been compacted. This avoids retaining every historical
  // run.started/input event forever while keeping the current status inspectable.
  return event.eventId === latestStatusEventId;
}

function findActiveExecutionIds(events: readonly MissionEvent[]): ReadonlySet<string> {
  const latest = new Map<string, MissionEvent>();
  for (const event of events) {
    const executionId = readString(event.data["executionId"]);
    if (executionId === undefined) continue;
    const previous = latest.get(executionId);
    if (previous === undefined || previous.sequence < event.sequence)
      latest.set(executionId, event);
  }
  return new Set(
    [...latest.entries()]
      .filter(([, event]) => !isTerminalMissionEventType(event.type))
      .map(([executionId]) => executionId),
  );
}

function findLatestStatusEventId(events: readonly MissionEvent[]): string | undefined {
  return [...events].toReversed().find((event) => isStatusEventType(event.type))?.eventId;
}

function isNonTerminalCommand(command: MissionCommand | undefined): boolean {
  return command !== undefined && !isTerminalMissionCommandState(command.state);
}

function isNonTerminalOperation(operation: MissionOperationProjection | undefined): boolean {
  return operation !== undefined && !isTerminalMissionOperationState(operation.state);
}

function isStatusEventType(type: string): boolean {
  return STATUS_EVENT_TYPES.has(type);
}

function selectRetainedItems<T>(
  items: readonly T[],
  mandatory: (item: T) => boolean,
  limits: MissionRetentionLimits,
  size: (item: T) => number,
): readonly T[] {
  const selected = new Set<T>();
  for (const item of items) {
    if (mandatory(item)) selected.add(item);
  }

  const tail = items.filter((item) => !selected.has(item));
  let retainedTailCount = 0;
  let retainedTailBytes = 0;
  // Always retain the newest terminal/tail record.  A single record larger
  // than maxBytes is not made disappear; maxBytes is a compaction budget, not
  // permission to lose the only durable terminal result.
  const newest = tail.at(-1);
  if (newest !== undefined) {
    selected.add(newest);
    retainedTailCount = 1;
    retainedTailBytes = size(newest);
  }
  for (const item of tail.toReversed()) {
    if (selected.has(item)) continue;
    const itemBytes = size(item);
    if (retainedTailCount >= limits.maxCount || retainedTailBytes + itemBytes > limits.maxBytes)
      break;
    selected.add(item);
    retainedTailCount += 1;
    retainedTailBytes += itemBytes;
  }
  return items.filter((item) => selected.has(item));
}

function serializedBytes(value: unknown): number {
  return serializedRetentionBytes(value);
}

/** Byte accounting used by both the compactor and the local benchmark. */
export function serializedRetentionBytes(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
