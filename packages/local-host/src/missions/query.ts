import { missionContentReference, readMissionContentValue } from "../mission-content-query.ts";
import {
  createIntegrationError,
  ExecutorReferenceSchema,
  HumanInteractionRequestEnvelopeSchema,
  IntegrationErrorSchema,
  JsonValueSchema,
  MissionEventViewItemSchema,
  MissionEventsSchema,
  MissionResultSchema,
  MissionSummarySchema,
  MissionSummaryV2Schema,
  MissionBoundedResultSchema,
  MissionScalarEventDataSchema,
  MissionBoundedEventsSchema,
  type MissionBoundedResult,
  type MissionBoundedEvents,
  type ContentSelector,
  type MissionContentRead,
  MissionResultV2Schema,
  type MissionSummaryV2,
  type MissionResultV2,
  type JsonValue,
  type MissionEventViewItem,
  type MissionEvents,
  type MissionResult,
  type MissionSummary,
} from "@pragma/shared/integration";
import { AgentMessageUsageSchema, type Mission } from "@pragma/shared";

import {
  makeMissionEventCursor,
  parseMissionEventCursor,
  type MissionControllerStore,
} from "./controller/mission-controller-store.ts";
import type { MissionEvent } from "./controller/schemas.ts";

export type MissionQueryView = "summary" | "result" | "chat" | "work" | "events" | "content";

export interface MissionQueryRequest {
  readonly missionId: string;
  readonly view: MissionQueryView;
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly queryVersion?: 1 | 2 | undefined;
  readonly includeRecentInput?: boolean | undefined;
  readonly maxContentBytes?: number | undefined;
  readonly content?: ContentSelector | undefined;
}

export type MissionQueryResult =
  | MissionSummary
  | MissionResult
  | MissionEvents
  | MissionSummaryV2
  | MissionResultV2
  | MissionBoundedResult
  | MissionBoundedEvents
  | MissionContentRead;

export interface MissionQueryPort {
  readonly queryMission: (input: MissionQueryRequest) => Promise<MissionQueryResult>;
}

export const SUPPORTED_MISSION_QUERY_VIEWS = ["summary", "result", "events", "content"] as const;

interface ExecutionProjection {
  readonly status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "interrupted";
  readonly executionId?: string | undefined;
  readonly result?: JsonValue | undefined;
  readonly hasResult: boolean;
  readonly usage?: MissionResult["usage"] | undefined;
  readonly occurredAt?: string | undefined;
  readonly interaction?: MissionResult["interaction"] | undefined;
  readonly error?: MissionResult["error"] | undefined;
}

/**
 * Compose the real read-only Mission projection at the Local Host boundary.
 * The controller owns storage and cursor validation; this module owns only
 * view semantics and deliberately has no CLI dependency.
 */
export function createMissionQuery(options: {
  readonly controller: Pick<MissionControllerStore, "readSnapshot">;
  readonly readMission?: ((missionId: string) => Promise<Mission | undefined>) | undefined;
  readonly readLatestInput?:
    ((missionId: string) => Promise<{ id: string; content: string } | undefined>) | undefined;
}): MissionQueryPort {
  return {
    async queryMission(input) {
      if (input.view === "chat" || input.view === "work") {
        throw unsupportedMissionView(input.view);
      }
      assertQueryLimit(input.limit);
      if (
        input.maxContentBytes !== undefined &&
        (!Number.isSafeInteger(input.maxContentBytes) ||
          input.maxContentBytes < 4 ||
          input.maxContentBytes > 64000)
      )
        throw createIntegrationError({
          code: "INVALID_ARGUMENT",
          category: "usage",
          message: "Content budget must be 4..64000 bytes.",
        });

      const mission = await options.readMission?.(input.missionId);
      const snapshot = await options.controller.readSnapshot(
        input.view === "events" && input.cursor !== undefined
          ? { missionId: input.missionId, after: input.cursor }
          : { missionId: input.missionId },
      );
      if (mission === undefined)
        assertMissionExists(input.missionId, snapshot.snapshot.eventSequence, snapshot.events);

      const semantics =
        input.queryVersion === 2 && input.view !== "events"
          ? {
              title: mission?.title ?? eventTitle(snapshot.events),
              ...(input.includeRecentInput && mission !== undefined
                ? await recentInput(options, input.missionId)
                : {}),
            }
          : undefined;
      if (input.view === "content") {
        if (input.content === undefined)
          throw createIntegrationError({
            code: "INVALID_ARGUMENT",
            category: "usage",
            message: "Content view requires a selector.",
          });
        const selector = input.content;
        if (selector.source === "queue")
          throw createIntegrationError({
            code: "DEPENDENCY_UNAVAILABLE", category: "dependency",
            message: "Queue content requires the Host queue read port.",
          });
        let eventSequence: number | undefined;
        if (selector.source === "event") {
          try {
            eventSequence = parseMissionEventCursor(selector.id, input.missionId);
          } catch {
            /* IDs and decimal sequences remain valid selectors. */
          }
        }

        const event =
          selector.source === "result"
            ? snapshot.events
                .toReversed()
                .find(
                  (event) =>
                    event.type === "run.succeeded" &&
                    (event.data["executionId"] === selector.id ||
                      (selector.id.startsWith("event:") && event.eventId === selector.id.slice(6))),
                )
            : snapshot.events.find(
                (event) =>
                  event.eventId === selector.id ||
                  String(event.sequence) === selector.id ||
                  event.sequence === eventSequence,
              );
        const scalar = MissionScalarEventDataSchema.safeParse(event?.data);
        const value =
          selector.source === "result"
            ? event?.data["result"]
            : scalar.success
              ? scalar.data.value
              : event?.data;
        if (value === undefined)
          throw createIntegrationError({
            code: "NOT_FOUND",
            category: "not_found",
            message: "The referenced Mission content is no longer available.",
          });
        return readMissionContentValue(input.missionId, selector, value);
      }
      switch (input.view) {
        case "summary":
          return withSemantics(
            projectMissionSummary({
              missionId: input.missionId,
              snapshot,
              mission,
            }),
            semantics,
          );
        case "result":
          return boundedMissionResult(
            withSemantics(
              projectMissionResult({
                missionId: input.missionId,
                snapshot,
                mission,
              }),
              semantics,
            ),
            input.maxContentBytes,
            snapshot.events.toReversed().find((event) => event.type === "run.succeeded")?.eventId,
          );
        case "events":
          return boundedMissionEvents(
            projectMissionEvents({
              missionId: input.missionId,
              events: snapshot.events,
              limit: input.limit,
            }),
            input.maxContentBytes,
          );
        default:
          return unreachableMissionQueryView(input.view);
      }
    },
  };
}

export function projectMissionSummary(input: {
  readonly missionId: string;
  readonly snapshot: Awaited<ReturnType<MissionControllerStore["readSnapshot"]>>;
  readonly mission?: Mission | undefined;
}): MissionSummary {
  if (input.mission !== undefined) {
    const mission = input.mission;
    const execution = resolveCurrentExecution(input.snapshot.events, mission.execution);
    const status =
      execution === undefined
        ? (mission.execution?.status ?? "queued")
        : summaryStatus(execution.status);
    const currentExecution =
      execution === undefined ? mission.execution : executionSummary(execution);
    const updatedAt =
      execution?.occurredAt !== undefined && execution.occurredAt > mission.updatedAt
        ? execution.occurredAt
        : mission.updatedAt;
    return MissionSummarySchema.parse({
      schemaVersion: "pragma.mission-summary/v1",
      missionId: mission.id,
      status,
      lifecycleStatus: mission.lifecycleStatus,
      executor: {
        kind: mission.executor.kind,
        id: mission.executor.ref.slice(mission.executor.ref.indexOf(":") + 1),
      },
      ...(currentExecution === undefined
        ? {}
        : { execution: { id: currentExecution.id, status: currentExecution.status } }),
      workspace: { canonicalPath: mission.workspace.path },
      createdAt: mission.createdAt,
      updatedAt,
      eventSequence: input.snapshot.snapshot.eventSequence,
      cursor: input.snapshot.cursor,
    });
  }
  const created = findCreatedEvent(input.snapshot.events);
  const execution = projectExecution(input.snapshot.events);
  const executor = ExecutorReferenceSchema.safeParse(created.data["executor"]);
  const workspace = readWorkspace(created.data["workspace"]);
  const latest = input.snapshot.events.at(-1) ?? created;
  const status = summaryStatus(execution.status);
  const executionView = executionSummary(execution);

  return MissionSummarySchema.parse({
    schemaVersion: "pragma.mission-summary/v1",
    missionId: input.missionId,
    status,
    lifecycleStatus: lifecycleStatus(status),
    ...(executor.success ? { executor: executor.data } : {}),
    ...(executionView === undefined ? {} : { execution: executionView }),
    ...(workspace === undefined ? {} : { workspace }),
    createdAt: created.occurredAt,
    updatedAt: latest.occurredAt,
    eventSequence: input.snapshot.snapshot.eventSequence,
    cursor: input.snapshot.cursor,
  });
}

export function projectMissionResult(input: {
  readonly missionId: string;
  readonly snapshot: Awaited<ReturnType<MissionControllerStore["readSnapshot"]>>;
  readonly mission?: Mission | undefined;
}): MissionResult {
  const execution =
    input.mission === undefined
      ? projectExecution(input.snapshot.events)
      : resolveCurrentExecution(input.snapshot.events, input.mission.execution);
  if (execution === undefined) {
    throw createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: "The current Mission execution has no durable controller result facts.",
      details: { missionId: input.missionId, reason: "mission_execution_facts_unavailable" },
    });
  }
  return MissionResultSchema.parse({
    schemaVersion: "pragma.mission-result/v1",
    missionId: input.missionId,
    ...(validExecutionId(execution.executionId) ? { executionId: execution.executionId } : {}),
    status: execution.status,
    available: execution.status === "succeeded" && execution.hasResult,
    ...(execution.hasResult && execution.result !== undefined ? { result: execution.result } : {}),
    ...(execution.usage === undefined ? {} : { usage: execution.usage }),
    ...(execution.occurredAt === undefined ? {} : { occurredAt: execution.occurredAt }),
    ...(execution.interaction === undefined ? {} : { interaction: execution.interaction }),
    ...(execution.error === undefined ? {} : { error: execution.error }),
  });
}

export function projectMissionEvents(input: {
  readonly missionId: string;
  readonly events: readonly MissionEvent[];
  readonly limit: number;
}): MissionEvents {
  const items = input.events.slice(0, input.limit).map((event) => missionEventItem(event));
  const last = items.at(-1);
  const hasMore = items.length < input.events.length;
  return MissionEventsSchema.parse({
    schemaVersion: "pragma.mission-events/v1",
    missionId: input.missionId,
    items,
    ...(hasMore && last !== undefined
      ? { nextCursor: makeMissionEventCursor(input.missionId, last.sequence) }
      : {}),
  });
}

function resolveCurrentExecution(
  events: readonly MissionEvent[],
  current: Mission["execution"],
): ExecutionProjection | undefined {
  if (current === undefined) return projectExecution(events);
  const accepted = events.toReversed().find((event) => event.type === "run.accepted");
  const latestStarted = events
    .toReversed()
    .find((event) => event.type === "run.started" || event.type === "execution.started");
  const acceptedRequestId = accepted?.data["requestId"] ?? accepted?.data["inputMessageId"];
  if (
    accepted !== undefined &&
    (latestStarted === undefined || accepted.sequence > latestStarted.sequence) &&
    acceptedRequestId !== current.inputMessageId
  )
    return { status: "queued", hasResult: false };
  const hasCurrentAnchor = events.some(
    (event) =>
      (event.type === "run.started" || event.type === "execution.started") &&
      event.data["executionId"] === current.id,
  );
  if (!hasCurrentAnchor) return undefined;
  return projectExecution(events, current.id);
}

function projectExecution(
  events: readonly MissionEvent[],
  executionId?: string,
): ExecutionProjection {
  const anchor = [...events]
    .toReversed()
    .find(
      (event) =>
        (event.type === "run.started" || event.type === "execution.started") &&
        (executionId === undefined || event.data["executionId"] === executionId),
    );
  const latestAccepted = [...events].toReversed().find((event) => event.type === "run.accepted");

  // A Mission may contain an earlier successful turn followed by a newly
  // accepted turn that has not started yet. Never expose the earlier result.
  if (
    anchor === undefined ||
    (latestAccepted !== undefined && latestAccepted.sequence > anchor.sequence)
  ) {
    return { status: "queued", hasResult: false };
  }

  const anchorExecutionId = readString(anchor.data["executionId"]);
  let projection: ExecutionProjection = {
    status: "running",
    ...(anchorExecutionId === undefined ? {} : { executionId: anchorExecutionId }),
    hasResult: false,
    occurredAt: anchor.occurredAt,
  };

  for (const event of events) {
    if (event.sequence <= anchor.sequence) continue;
    const eventExecutionId = readString(event.data["executionId"]);
    if (
      eventExecutionId !== undefined &&
      projection.executionId !== undefined &&
      eventExecutionId !== projection.executionId
    ) {
      continue;
    }
    if (eventExecutionId !== undefined && projection.executionId === undefined) {
      projection = { ...projection, executionId: eventExecutionId };
    }

    switch (event.type) {
      case "run.accepted":
        projection = { status: "queued", hasResult: false };
        break;
      case "run.started":
      case "execution.started":
      case "run.progress":
      case "human.interaction.resolved":
        projection = {
          status: "running",
          ...(projection.executionId === undefined ? {} : { executionId: projection.executionId }),
          hasResult: false,
          occurredAt: event.occurredAt,
        };
        break;
      case "run.input_required":
      case "human.interaction.requested": {
        const interaction = HumanInteractionRequestEnvelopeSchema.safeParse(
          event.type === "run.input_required" ? event.data["interaction"] : event.data,
        );
        projection = {
          status: "waiting",
          ...(projection.executionId === undefined ? {} : { executionId: projection.executionId }),
          hasResult: false,
          occurredAt: event.occurredAt,
          ...(interaction.success ? { interaction: interaction.data } : {}),
        };
        break;
      }
      case "run.succeeded": {
        const result = JsonValueSchema.safeParse(event.data["result"]);
        const usage = readUsage(event.data["usage"]);
        projection = {
          status: "succeeded",
          ...(projection.executionId === undefined ? {} : { executionId: projection.executionId }),
          result: result.success ? result.data : null,
          hasResult: true,
          occurredAt: event.occurredAt,
          ...(usage === undefined ? {} : { usage }),
        };
        break;
      }
      case "run.failed":
        projection = {
          status: "failed",
          ...(projection.executionId === undefined ? {} : { executionId: projection.executionId }),
          hasResult: false,
          occurredAt: event.occurredAt,
          error: readError(event.data["error"]),
        };
        break;
      case "run.interrupted":
        projection = {
          status: "interrupted",
          ...(projection.executionId === undefined ? {} : { executionId: projection.executionId }),
          hasResult: false,
          occurredAt: event.occurredAt,
        };
        break;
    }
  }
  return projection;
}

function missionEventItem(event: MissionEvent): MissionEventViewItem {
  return MissionEventViewItemSchema.parse({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    missionId: event.missionId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: event.type,
    data: event.data,
  });
}

function findCreatedEvent(events: readonly MissionEvent[]): MissionEvent {
  const created = events.find((event) => event.type === "mission.created");
  if (created === undefined) {
    throw createIntegrationError({
      code: "MISSION_NOT_FOUND",
      category: "not_found",
      message: "Mission not found.",
    });
  }
  return created;
}

function assertMissionExists(
  missionId: string,
  eventSequence: number,
  events: readonly MissionEvent[],
): void {
  if (eventSequence > 0 || events.some((event) => event.type === "mission.created")) return;
  throw createIntegrationError({
    code: "MISSION_NOT_FOUND",
    category: "not_found",
    message: `Mission not found: ${missionId}.`,
    details: { missionId },
  });
}

function missionStatusForExecution(
  status: ExecutionProjection["status"],
): MissionSummary["status"] {
  return status === "interrupted" ? "cancelled" : status;
}

function summaryStatus(status: ExecutionProjection["status"]): MissionSummary["status"] {
  return missionStatusForExecution(status);
}

function lifecycleStatus(status: MissionSummary["status"]): MissionSummary["lifecycleStatus"] {
  if (status === "queued") return "queued";
  if (status === "succeeded" || status === "failed" || status === "cancelled") {
    return "completed";
  }
  return "active";
}

function executionSummary(
  projection: ExecutionProjection,
): MissionSummary["execution"] | undefined {
  if (!validExecutionId(projection.executionId)) return undefined;
  return {
    id: projection.executionId,
    status: projection.status,
  };
}

function readWorkspace(value: unknown): { readonly canonicalPath: string } | undefined {
  if (typeof value === "string" && value.length > 0) return { canonicalPath: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const canonicalPath = (value as { readonly canonicalPath?: unknown }).canonicalPath;
  return typeof canonicalPath === "string" && canonicalPath.length > 0
    ? { canonicalPath }
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validExecutionId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function readUsage(value: unknown): MissionResult["usage"] | undefined {
  const parsed = AgentMessageUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readError(value: unknown): MissionResult["error"] {
  const parsed = IntegrationErrorSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return createIntegrationError({
    code: "EXECUTION_FAILED",
    category: "execution",
    message: "Mission execution failed.",
    retryable: false,
  });
}

function assertQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Mission query limit must be a positive integer.",
      details: { limit },
    });
  }
}

export function unsupportedMissionView(view: "chat" | "work") {
  return createIntegrationError({
    code: "INVALID_ARGUMENT",
    category: "usage",
    message: `Mission view ${view} is not available yet; use --view events or mission watch.`,
    details: {
      view,
      supportedViews: [...SUPPORTED_MISSION_QUERY_VIEWS],
    },
  });
}

function unreachableMissionQueryView(view: never): never {
  throw createIntegrationError({
    code: "INVALID_ARGUMENT",
    category: "usage",
    message: `Mission view ${String(view)} is invalid; use summary, result, or events.`,
    details: {
      view: String(view),
      supportedViews: [...SUPPORTED_MISSION_QUERY_VIEWS],
    },
  });
}

function eventTitle(events: readonly MissionEvent[]): string | null {
  const title = events.find((event) => event.type === "mission.created")?.data["title"];
  return typeof title === "string" && title.trim().length > 0 && title.length <= 120 ? title : null;
}

async function recentInput(
  options: {
    readLatestInput?:
      ((id: string) => Promise<{ id: string; content: string } | undefined>) | undefined;
  },
  missionId: string,
) {
  const message = await options.readLatestInput?.(missionId);
  if (message === undefined) return {};
  const chars = Array.from(message.content);
  return {
    recentInput: {
      messageId: message.id,
      text: chars.slice(0, 250).join(""),
      truncated: chars.length > 250,
    },
  };
}

function withSemantics<T extends MissionSummary | MissionResult>(
  value: T,
  semantics:
    | {
        title: string | null;
        recentInput?: { messageId: string; text: string; truncated: boolean };
      }
    | undefined,
): T | MissionSummaryV2 | MissionResultV2 {
  if (semantics === undefined) return value;
  return value.schemaVersion === "pragma.mission-summary/v1"
    ? MissionSummaryV2Schema.parse({
        ...value,
        ...semantics,
        schemaVersion: "pragma.mission-summary/v2",
      })
    : MissionResultV2Schema.parse({
        ...value,
        ...semantics,
        schemaVersion: "pragma.mission-result/v2",
      });
}

function boundedMissionResult(
  value: MissionSummary | MissionResult | MissionSummaryV2 | MissionResultV2,
  maxBytes?: number,
  resultEventId?: string,
) {
  if (
    maxBytes === undefined ||
    !("result" in value) ||
    value.result === undefined ||
    ((!("executionId" in value) || value.executionId === undefined) && resultEventId === undefined)
  )
    return value;
  const resultContent = missionContentReference(
    value.missionId,
    "result",
    "executionId" in value && value.executionId !== undefined
      ? value.executionId
      : `event:${resultEventId}`,
    value.result,
    maxBytes,
  );
  if (resultContent === undefined) return value;
  return MissionBoundedResultSchema.parse({
    ...value,
    schemaVersion: "pragma.mission-result/v3",
    title: "title" in value ? value.title : null,
    result: undefined,
    resultContent,
  });
}
function boundedMissionEvents(value: MissionEvents, maxBytes?: number) {
  if (maxBytes === undefined) return value;
  let remaining = maxBytes;
  return MissionBoundedEventsSchema.parse({
    ...value,
    schemaVersion: "pragma.mission-events/v2",
    items: value.items.map((item) => {
      const scalar = MissionScalarEventDataSchema.safeParse(item.data);
      const data = scalar.success ? scalar.data.value : item.data;
      const reference =
        item.type.includes("human.") ||
        item.type.includes("interaction") ||
        item.type.includes("input_required") ||
        item.type.includes("failed")
          ? undefined
          : missionContentReference(value.missionId, "event", item.eventId, data, remaining);
      remaining = Math.max(
        0,
        remaining -
          Buffer.byteLength(reference === undefined ? JSON.stringify(data) : reference.preview),
      );
      return {
        ...item,
        schemaVersion: "pragma.local-host-mission-event/v2",
        data,
        ...(reference === undefined ? {} : { data: undefined, dataContent: reference }),
      };
    }),
  });
}
