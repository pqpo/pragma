import type { ExecutionStore } from "@pragma/core";

import type { MissionControllerStore } from "./controller/mission-controller-store.ts";
import type { MissionEvent } from "./controller/schemas.ts";

export type MissionActivityStatus =
  "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface MissionActivityInput {
  readonly missionId: string;
  readonly execution: {
    readonly id: string;
    readonly status: MissionActivityStatus;
    readonly updatedAt: string;
  };
}

export interface MissionActivitySnapshot {
  readonly executionId: string;
  readonly status: MissionActivityStatus;
  readonly updatedAt: string;
  readonly source: "mission-events" | "core-execution" | "persisted-metadata";
  readonly degraded: boolean;
}

export interface MissionActivityReader {
  read(input: MissionActivityInput): Promise<MissionActivitySnapshot>;
  readMany(inputs: readonly MissionActivityInput[]): Promise<MissionActivitySnapshot[]>;
}

/**
 * Resolves one effective Mission activity state at the Local Host boundary.
 *
 * Durable Mission events are the normal read authority. An active or missing
 * event projection is checked against the canonical Core Execution so a
 * terminal fact cannot remain displayed as working after a partial Host
 * projection. Reads never mutate either store and therefore never depend on a
 * best-effort background repair.
 */
export function createMissionActivityReader(options: {
  readonly controller: Pick<MissionControllerStore, "readSnapshot">;
  readonly executions: Pick<ExecutionStore, "get">;
  readonly canonicalReadTimeoutMs?: number | undefined;
  readonly listReadBudgetMs?: number | undefined;
  readonly activeCacheTtlMs?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly onReadFailure?:
    | ((input: {
        readonly missionId: string;
        readonly source: "mission-events" | "core-execution";
        readonly error: unknown;
      }) => void)
    | undefined;
}): MissionActivityReader {
  const readTimeoutMs = options.canonicalReadTimeoutMs ?? 250;
  const listReadBudgetMs = options.listReadBudgetMs ?? 250;
  const activeCacheTtlMs = options.activeCacheTtlMs ?? 1_000;
  const concurrency = options.concurrency ?? 8;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Mission activity read concurrency must be a positive integer.");
  }

  const cache = new Map<
    string,
    {
      readonly inputUpdatedAt: string;
      readonly cachedAt: number;
      readonly snapshot: MissionActivitySnapshot;
    }
  >();
  const inFlight = new Map<string, Promise<MissionActivitySnapshot>>();

  const readUncached = async (input: MissionActivityInput): Promise<MissionActivitySnapshot> => {
    let degraded = false;
    const projected = await within(
      options.controller.readSnapshot({ missionId: input.missionId }),
      readTimeoutMs,
      `Mission event projection read timed out after ${readTimeoutMs}ms.`,
    )
      .then((snapshot) => projectMissionExecutionActivity(snapshot.events, input.execution.id))
      .catch((error: unknown) => {
        degraded = true;
        options.onReadFailure?.({
          missionId: input.missionId,
          source: "mission-events",
          error,
        });
        return undefined;
      });

    if (projected !== undefined && isTerminal(projected.status)) {
      return { ...projected, source: "mission-events", degraded };
    }

    const canonical = await within(
      options.executions.get(input.execution.id),
      readTimeoutMs,
      `Mission canonical Execution read timed out after ${readTimeoutMs}ms.`,
    ).catch((error: unknown) => {
      degraded = true;
      options.onReadFailure?.({
        missionId: input.missionId,
        source: "core-execution",
        error,
      });
      return undefined;
    });
    const canonicalStatus = normalizeExecutionStatus(canonical?.status);
    if (canonical !== undefined && canonicalStatus !== undefined && isTerminal(canonicalStatus)) {
      if (projected === undefined || !isTerminal(projected.status)) {
        degraded = true;
        options.onReadFailure?.({
          missionId: input.missionId,
          source: "mission-events",
          error: new Error(
            `Mission event projection is missing canonical terminal Execution ${input.execution.id}.`,
          ),
        });
      }
      return {
        executionId: input.execution.id,
        status: canonicalStatus,
        updatedAt: canonical.updatedAt,
        source: "core-execution",
        degraded,
      };
    }

    if (projected !== undefined) {
      return { ...projected, source: "mission-events", degraded };
    }
    return {
      executionId: input.execution.id,
      status: input.execution.status,
      updatedAt: input.execution.updatedAt,
      source: "persisted-metadata",
      degraded,
    };
  };

  const read = async (input: MissionActivityInput): Promise<MissionActivitySnapshot> => {
    const operationKey = `${input.missionId}:${input.execution.id}:${input.execution.updatedAt}`;
    const existing = inFlight.get(operationKey);
    if (existing !== undefined) return await existing;
    const operation = readUncached(input)
      .then((snapshot) => {
        cache.set(input.missionId, {
          inputUpdatedAt: input.execution.updatedAt,
          cachedAt: Date.now(),
          snapshot,
        });
        return snapshot;
      })
      .finally(() => inFlight.delete(operationKey));
    inFlight.set(operationKey, operation);
    return await operation;
  };

  return {
    read,
    async readMany(inputs) {
      const now = Date.now();
      const result = inputs.map((input) => {
        const cached = cache.get(input.missionId);
        if (
          cached !== undefined &&
          cached.snapshot.executionId === input.execution.id &&
          cached.inputUpdatedAt === input.execution.updatedAt &&
          (isTerminal(cached.snapshot.status) || now - cached.cachedAt <= activeCacheTtlMs)
        ) {
          return cached.snapshot;
        }
        return persistedMetadataSnapshot(input);
      });
      const work = mapConcurrent(inputs, concurrency, async (input) => await read(input)).then(
        (snapshots) => {
          for (let index = 0; index < snapshots.length; index += 1) {
            result[index] = snapshots[index]!;
          }
        },
      );
      // The rail has a strict latency budget. Slow per-Mission I/O continues in
      // the background and warms the bounded cache for the next render instead
      // of blocking the entire list behind the slowest owner.
      await within(work, listReadBudgetMs, "Mission activity list read budget elapsed.").catch(
        () => undefined,
      );
      void work.catch(() => undefined);
      return result;
    },
  };
}

function persistedMetadataSnapshot(input: MissionActivityInput): MissionActivitySnapshot {
  return {
    executionId: input.execution.id,
    status: input.execution.status,
    updatedAt: input.execution.updatedAt,
    source: "persisted-metadata",
    degraded: false,
  };
}

export function projectMissionExecutionActivity(
  events: readonly MissionEvent[],
  executionId: string,
): Omit<MissionActivitySnapshot, "source" | "degraded"> | undefined {
  const anchorIndex = events.findLastIndex(
    (event) =>
      (event.type === "run.started" || event.type === "execution.started") &&
      event.data["executionId"] === executionId,
  );
  if (anchorIndex < 0) return undefined;

  const anchor = events[anchorIndex]!;
  let status: MissionActivityStatus = "running";
  let updatedAt = anchor.occurredAt;
  for (const event of events.slice(anchorIndex + 1)) {
    if (
      (event.type === "run.started" || event.type === "execution.started") &&
      event.data["executionId"] !== executionId
    ) {
      break;
    }
    const eventExecutionId = event.data["executionId"];
    if (typeof eventExecutionId === "string" && eventExecutionId !== executionId) continue;
    const nextStatus = missionActivityStatusForEvent(event.type);
    if (nextStatus === undefined) continue;
    status = nextStatus;
    updatedAt = event.occurredAt;
  }
  return { executionId, status, updatedAt };
}

function missionActivityStatusForEvent(type: string): MissionActivityStatus | undefined {
  switch (type) {
    case "run.succeeded":
      return "succeeded";
    case "run.failed":
      return "failed";
    case "run.interrupted":
    case "run.cancelled":
    case "execution.cancelled":
      return "cancelled";
    case "run.input_required":
    case "human.requested":
    case "human.interaction.requested":
      return "waiting";
    case "human.interaction.resolved":
    case "run.progress":
      return "running";
    default:
      return undefined;
  }
}

function normalizeExecutionStatus(status: string | undefined): MissionActivityStatus | undefined {
  switch (status) {
    case "queued":
    case "running":
    case "waiting":
    case "succeeded":
    case "failed":
    case "cancelled":
      return status;
    case "interrupted":
      return "cancelled";
    default:
      return undefined;
  }
}

function isTerminal(status: MissionActivityStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

async function mapConcurrent<T, TResult>(
  values: readonly T[],
  concurrency: number,
  project: (value: T) => Promise<TResult>,
): Promise<TResult[]> {
  const result = new Array<TResult>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        result[index] = await project(values[index]!);
      }
    }),
  );
  return result;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
