import { JsonValueSchema, type JsonValue } from "@pragma/shared";
import { createIntegrationError } from "@pragma/shared/integration";

import {
  makeMissionEventCursor,
  type MissionControllerStore,
  type MissionWatchBarrier,
} from "./mission-controller-store.ts";

export type MissionWatchUntil = "terminal" | "input-required";

export interface MissionWatchEvent {
  readonly type: string;
  readonly data: JsonValue;
  readonly missionId: string;
  readonly executionId?: string | undefined;
  /** Durable Mission events retain their eventId; synthetic events omit it. */
  readonly eventId?: string | undefined;
  readonly occurredAt?: string | undefined;
  readonly replayable: boolean;
  readonly cursor?: string | undefined;
}

export interface MissionWatchRequest {
  readonly missionId: string;
  readonly after?: string | undefined;
  readonly replay?: number | undefined;
  readonly until?: MissionWatchUntil | undefined;
  readonly signal?: AbortSignal | undefined;
  /** The callback is awaited before the watcher advances its durable cursor. */
  readonly onEvent: (event: MissionWatchEvent) => Promise<void> | void;
  /** Test/embedded-host override; the CLI uses the bounded default. */
  readonly pollIntervalMs?: number | undefined;
}

export interface MissionWatchResult {
  readonly missionId: string;
  readonly status: "detached" | "completed";
  readonly missionContinues: boolean;
  readonly lastCursor: string;
  readonly until?: MissionWatchUntil | undefined;
}

export interface MissionWatchPort {
  readonly watch: (input: MissionWatchRequest) => Promise<MissionWatchResult>;
}

const DEFAULT_WATCH_REPLAY = 50;
const DEFAULT_WATCH_POLL_INTERVAL_MS = 250;
const MAX_WATCH_REPLAY = 1_000;
const MAX_SEEN_EVENT_IDS = 4_096;

export function createMissionWatchApplication(options: {
  readonly controller: Pick<MissionControllerStore, "readWatchBarrier">;
  readonly pollIntervalMs?: number | undefined;
  readonly maxSeenEventIds?: number | undefined;
}): MissionWatchPort {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS;
  const maxSeenEventIds = options.maxSeenEventIds ?? MAX_SEEN_EVENT_IDS;
  assertPositiveInteger(pollIntervalMs, "pollIntervalMs");
  assertPositiveInteger(maxSeenEventIds, "maxSeenEventIds");

  return {
    async watch(input) {
      const replay = input.replay ?? DEFAULT_WATCH_REPLAY;
      if (input.after !== undefined && input.replay !== undefined) {
        throw watchArgumentError("Mission watch accepts either after or replay, not both.");
      }
      if (!Number.isSafeInteger(replay) || replay < 0 || replay > MAX_WATCH_REPLAY) {
        throw watchArgumentError("Mission watch replay must be an integer between 0 and 1000.");
      }
      const requestedPollInterval = input.pollIntervalMs ?? pollIntervalMs;
      assertPositiveInteger(requestedPollInterval, "pollIntervalMs");

      const seenEventIds = new BoundedEventIdSet(maxSeenEventIds);
      const first = await options.controller.readWatchBarrier({
        missionId: input.missionId,
        ...(input.after === undefined ? { replay } : { after: input.after }),
      });
      let status = statusFromEventType(first.latestStatusEventType);
      for (const event of first.events) {
        const delivered = await deliverDurableEvent(input, event, seenEventIds);
        if (delivered) status = statusFromEventType(event.type, status);
      }

      const snapshotEvent = createSnapshotEvent(first, status);
      await input.onEvent(snapshotEvent);
      let lastCursor = first.cursor;
      await input.onEvent(createReadyEvent(first, first.events.length));

      status = statusFromEventType(first.latestStatusEventType, status);
      if (isUntilSatisfied(input.until, status)) {
        return completedResult(input, lastCursor, status);
      }

      for (;;) {
        if (isAborted(input.signal)) return detachedResult(input, lastCursor);
        const current = await options.controller.readWatchBarrier({
          missionId: input.missionId,
          after: lastCursor,
        });
        for (const event of current.events) {
          const delivered = await deliverDurableEvent(input, event, seenEventIds);
          if (delivered) status = statusFromEventType(event.type, status);
          lastCursor = makeMissionEventCursor(input.missionId, event.sequence);
          if (isUntilSatisfied(input.until, status)) {
            return completedResult(input, lastCursor, status);
          }
        }
        if (isAborted(input.signal)) return detachedResult(input, lastCursor);
        status = statusFromEventType(current.latestStatusEventType, status);
        if (isUntilSatisfied(input.until, status)) {
          return completedResult(input, lastCursor, status);
        }
        if ((await waitForPoll(input.signal, requestedPollInterval)) === false) {
          return detachedResult(input, lastCursor);
        }
      }
    },
  };
}

async function deliverDurableEvent(
  input: MissionWatchRequest,
  event: MissionWatchBarrier["events"][number],
  seenEventIds: BoundedEventIdSet,
): Promise<boolean> {
  if (seenEventIds.has(event.eventId)) return false;
  const data = JsonValueSchema.parse(event.data);
  const executionId = readExecutionId(event.data);
  const watched: MissionWatchEvent = {
    type: event.type,
    data,
    missionId: input.missionId,
    ...(executionId === undefined ? {} : { executionId }),
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    replayable: true,
    cursor: makeMissionEventCursor(input.missionId, event.sequence),
  };
  // Mark only after the consumer has accepted/flushed this event. If this
  // callback fails, the caller can reconnect from the preceding cursor.
  await input.onEvent(watched);
  seenEventIds.add(event.eventId);
  return true;
}

function createSnapshotEvent(
  barrier: MissionWatchBarrier,
  status: MissionWatchStatus,
): MissionWatchEvent {
  return {
    type: "mission.snapshot",
    missionId: barrier.snapshot.missionId,
    replayable: false,
    data: JsonValueSchema.parse({
      missionId: barrier.snapshot.missionId,
      status,
      eventSequence: barrier.snapshot.eventSequence,
      cursor: barrier.cursor,
      snapshot: barrier.snapshot,
    }),
  };
}

function createReadyEvent(barrier: MissionWatchBarrier, replayed: number): MissionWatchEvent {
  return {
    type: "watch.ready",
    missionId: barrier.snapshot.missionId,
    replayable: false,
    data: {
      missionId: barrier.snapshot.missionId,
      cursor: barrier.cursor,
      barrierSequence: barrier.barrierSequence,
      replayed,
      following: true,
    },
  };
}

function statusFromEventType(
  type: string | undefined,
  fallback: MissionWatchStatus = "unknown",
): MissionWatchStatus {
  switch (type) {
    case "mission.created":
      return "created";
    case "run.accepted":
    case "run.started":
    case "run.progress":
    case "human.interaction.resolved":
      return "running";
    case "human.interaction.requested":
    case "run.input_required":
      return "input_required";
    case "run.succeeded":
      return "succeeded";
    case "run.failed":
      return "failed";
    case "run.interrupted":
      return "interrupted";
    default:
      return fallback;
  }
}

type MissionWatchStatus =
  "unknown" | "created" | "running" | "input_required" | "succeeded" | "failed" | "interrupted";

function isUntilSatisfied(
  until: MissionWatchUntil | undefined,
  status: MissionWatchStatus,
): boolean {
  if (until === undefined) return false;
  if (until === "terminal") {
    return status === "succeeded" || status === "failed" || status === "interrupted";
  }
  return (
    status === "input_required" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "interrupted"
  );
}

function completedResult(
  input: MissionWatchRequest,
  lastCursor: string,
  status: MissionWatchStatus,
): MissionWatchResult {
  return {
    missionId: input.missionId,
    status: "completed",
    missionContinues: status === "input_required" || status === "running" || status === "created",
    lastCursor,
    ...(input.until === undefined ? {} : { until: input.until }),
  };
}

function detachedResult(input: MissionWatchRequest, lastCursor: string): MissionWatchResult {
  return {
    missionId: input.missionId,
    status: "detached",
    missionContinues: true,
    lastCursor,
  };
}

async function waitForPoll(
  signal: AbortSignal | undefined,
  milliseconds: number,
): Promise<boolean> {
  if (isAborted(signal)) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function readExecutionId(data: Record<string, unknown>): string | undefined {
  return typeof data["executionId"] === "string" ? data["executionId"] : undefined;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw watchArgumentError(`Mission watch ${name} must be a positive safe integer.`);
  }
}

function watchArgumentError(message: string) {
  return createIntegrationError({ code: "INVALID_ARGUMENT", category: "usage", message });
}

class BoundedEventIdSet {
  private readonly values = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maximum: number) {}

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    if (this.values.has(value)) return;
    this.values.add(value);
    this.order.push(value);
    while (this.order.length > this.maximum) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.values.delete(oldest);
    }
  }
}
