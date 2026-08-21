import {
  ExpertAgentStreamEventSchema,
  InvocationMessageAppendedEventSchema,
  type AgentMessageRecord,
  type ExecutionStatus,
  type Invocation,
} from "@pragma/shared";

import type { ExecutionStore } from "./execution-store.ts";

export type ExecutionWorkRecordKind =
  | "root"
  | "agent"
  | "runtime-agent"
  | "flow"
  | "task"
  | "human-task";

export interface ExecutionWorkTask {
  readonly taskId: string;
  readonly executionId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly sequence?: number | undefined;
  readonly status: ExecutionStatus;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExecutionWorkRecord {
  readonly recordId: string;
  readonly kind: ExecutionWorkRecordKind;
  readonly sessionId: string;
  readonly parentRecordId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly executorId?: string | undefined;
  readonly contextId?: string | undefined;
  readonly origin: "core" | "runtime";
  readonly status: ExecutionStatus;
  readonly tasks: readonly ExecutionWorkTask[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MutableWorkRecord {
  recordId: string;
  kind: ExecutionWorkRecordKind;
  sessionId: string;
  parentRecordId?: string | undefined;
  parentSessionId?: string | undefined;
  ownerInvocationId?: string | undefined;
  displayName?: string | undefined;
  executorId?: string | undefined;
  contextId?: string | undefined;
  origin: "core" | "runtime";
  tasks: Map<string, ExecutionWorkTask>;
  runtimeStatus?: ExecutionStatus | undefined;
  runtimeStatusOrder?: number | undefined;
  lastRuntimeRunOrder?: number | undefined;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeEventProjection {
  readonly invocationId: string;
  readonly order: number;
  readonly event: ReturnType<typeof ExpertAgentStreamEventSchema.parse>;
}

interface RuntimeDispatch {
  readonly commandId: string;
  delivery?: "followup" | "steer" | undefined;
  prompt?: string | undefined;
  readonly targetSessionIds: Set<string>;
}

export class ExecutionWorkHistoryReader {
  constructor(private readonly store: ExecutionStore) {}

  async listRecords(input: {
    readonly executionIds: readonly string[];
    readonly rootSessionId?: string | undefined;
  }, preloadedData?: Map<
    string,
    {
      readonly events: readonly import("@pragma/shared").ExecutionEvent[];
      readonly invocations: readonly Invocation[];
    }
  >): Promise<readonly ExecutionWorkRecord[]> {
    const records = new Map<string, MutableWorkRecord>();
    const recordByInvocationId = new Map<string, string>();
    const runtimeRecordBySessionId = new Map<string, string>();

    for (const executionId of input.executionIds) {
      const preloaded = preloadedData?.get(executionId);
      const [execution, invocations, agents, events] = preloaded
        ? await Promise.all([
            this.store.get(executionId),
            Promise.resolve(preloaded.invocations),
            this.store.listAgents(executionId),
            Promise.resolve(preloaded.events),
          ])
        : await Promise.all([
            this.store.get(executionId),
            this.store.listInvocations(executionId),
            this.store.listAgents(executionId),
            this.store.readEvents(executionId),
          ]);
      if (preloadedData !== undefined && !preloadedData.has(executionId)) {
        preloadedData.set(executionId, { events, invocations });
      }
      if (execution === undefined) continue;
      const rootInvocation = invocations.find(
        (invocation) => invocation.invocationId === execution.rootInvocationId,
      );
      if (rootInvocation !== undefined) {
        const isFlow = rootInvocation.definition.kind === "flow";
        const recordId = isFlow
          ? `invocation:${executionId}:${rootInvocation.invocationId}`
          : `root:${input.rootSessionId ?? executionId}`;
        const record = ensureRecord(records, {
          recordId,
          kind: isFlow ? "flow" : "root",
          sessionId: input.rootSessionId ?? executionId,
          executorId: rootInvocation.executorId,
          contextId: rootInvocation.contextId,
          origin: "core",
          createdAt: rootInvocation.createdAt,
          updatedAt: rootInvocation.updatedAt,
        });
        putTask(record, invocationTask(executionId, rootInvocation));
        recordByInvocationId.set(rootInvocation.invocationId, recordId);
      }

      for (const agent of agents) {
        const recordId = `agent:${executionId}:${agent.agentId}`;
        const record = ensureRecord(records, {
          recordId,
          kind: "agent",
          sessionId: agent.agentId,
          executorId: agent.definition.id,
          contextId: agent.contextId,
          origin: "core",
          ownerInvocationId: agent.createdByInvocationId,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
        });
        for (const invocation of invocations.filter(
          (candidate) => candidate.agentId === agent.agentId,
        )) {
          putTask(record, invocationTask(executionId, invocation));
          recordByInvocationId.set(invocation.invocationId, recordId);
        }
      }

      for (const invocation of invocations) {
        if (recordByInvocationId.has(invocation.invocationId)) continue;
        const recordId = `invocation:${executionId}:${invocation.invocationId}`;
        const kind =
          invocation.definition.kind === "human-task"
            ? "human-task"
            : invocation.definition.kind === "task"
              ? "task"
              : invocation.definition.kind === "flow"
                ? "flow"
                : "agent";
        const record = ensureRecord(records, {
          recordId,
          kind,
          sessionId: invocation.invocationId,
          executorId: invocation.executorId,
          contextId: invocation.contextId,
          origin: "core",
          ownerInvocationId: invocation.parentInvocationId,
          createdAt: invocation.createdAt,
          updatedAt: invocation.updatedAt,
        });
        putTask(record, invocationTask(executionId, invocation));
        recordByInvocationId.set(invocation.invocationId, recordId);
      }

      const runtimeEvents: RuntimeEventProjection[] = [];
      for (const [order, event] of events.entries()) {
        if (event.type !== "runtime.event") continue;
        const parsed = ExpertAgentStreamEventSchema.safeParse(event.data);
        if (parsed.success) {
          runtimeEvents.push({ invocationId: event.invocationId, order, event: parsed.data });
        }
      }
      const dispatches = collectRuntimeDispatches(runtimeEvents);
      const queuedDispatches = new Set<string>();
      const pendingPrompts = new Map<string, string[]>();

      for (const projected of runtimeEvents) {
        const streamEvent = projected.event;
        const source = streamEvent.source;
        if (streamEvent.type === "agent.command") {
          const dispatch = dispatches.get(streamEvent.payload.commandId);
          const targetSessionIds =
            dispatch === undefined
              ? streamEvent.payload.targetSessionIds
              : [...dispatch.targetSessionIds];
          for (const targetSessionId of targetSessionIds) {
            const targetRecordId = `runtime-agent:${targetSessionId}`;
            const target = ensureRecord(records, {
              recordId: targetRecordId,
              kind: "runtime-agent",
              sessionId: targetSessionId,
              parentSessionId:
                streamEvent.payload.senderSessionId ?? source.sessionId ?? source.parentSessionId,
              ownerInvocationId: projected.invocationId,
              origin: "runtime",
              createdAt: streamEvent.emittedAt,
              updatedAt: streamEvent.emittedAt,
            });
            runtimeRecordBySessionId.set(targetSessionId, targetRecordId);
            applyRuntimeCommandStatus(target, streamEvent, targetSessionId, projected.order);
          }
          if (
            dispatch !== undefined &&
            dispatch.prompt !== undefined &&
            dispatch.delivery !== "steer" &&
            !queuedDispatches.has(dispatch.commandId)
          ) {
            queuedDispatches.add(dispatch.commandId);
            for (const targetSessionId of dispatch.targetSessionIds) {
              const prompts = pendingPrompts.get(targetSessionId) ?? [];
              prompts.push(dispatch.prompt);
              pendingPrompts.set(targetSessionId, prompts);
            }
          }
        }
        if (source.sessionId === undefined || source.parentSessionId === undefined) continue;
        const recordId = `runtime-agent:${source.sessionId}`;
        const record = ensureRecord(records, {
          recordId,
          kind: "runtime-agent",
          sessionId: source.sessionId,
          parentSessionId: source.parentSessionId,
          ownerInvocationId: projected.invocationId,
          displayName: source.displayName,
          origin: "runtime",
          createdAt: streamEvent.emittedAt,
          updatedAt: streamEvent.emittedAt,
        });
        runtimeRecordBySessionId.set(source.sessionId, recordId);
        if (source.displayName !== undefined) record.displayName = source.displayName;
        if (isRuntimeRunEvent(streamEvent)) {
          const prompt =
            streamEvent.type === "run.started"
              ? pendingPrompts.get(source.sessionId)?.shift()
              : undefined;
          putRuntimeTask(
            record,
            executionId,
            projected.invocationId,
            streamEvent,
            projected.order,
            prompt,
          );
        }
      }
    }

    for (const record of records.values()) {
      if (record.origin === "runtime") {
        record.parentRecordId =
          (record.parentSessionId === undefined
            ? undefined
            : runtimeRecordBySessionId.get(record.parentSessionId)) ??
          (record.ownerInvocationId === undefined
            ? undefined
            : recordByInvocationId.get(record.ownerInvocationId));
      } else if (record.ownerInvocationId !== undefined) {
        record.parentRecordId = recordByInvocationId.get(record.ownerInvocationId);
      }
    }

    return [...records.values()]
      .map(finalizeRecord)
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async readOutput(
    input: {
      readonly executionIds: readonly string[];
      readonly record: ExecutionWorkRecord;
    },
    preloadedData?: Map<
      string,
      {
        readonly events: readonly import("@pragma/shared").ExecutionEvent[];
        readonly invocations: readonly Invocation[];
      }
    >,
  ): Promise<readonly AgentMessageRecord[]> {
    const invocationIds = new Set(input.record.tasks.map((task) => task.invocationId));
    const records: AgentMessageRecord[] = [];
    for (const executionId of input.executionIds) {
      const preloaded = preloadedData?.get(executionId);
      const [events, invocations] = preloaded
        ? [preloaded.events, preloaded.invocations]
        : await Promise.all([
            this.store.readEvents(executionId),
            this.store.listInvocations(executionId),
          ]);
      if (preloadedData !== undefined && !preloadedData.has(executionId)) {
        preloadedData.set(executionId, { events, invocations });
      }
      const invocationMap = new Map(
        invocations.map((invocation) => [invocation.invocationId, invocation]),
      );
      for (const event of events) {
        if (event.type !== "invocation.message.appended") continue;
        const parsed = InvocationMessageAppendedEventSchema.safeParse(event);
        if (!parsed.success) continue;
        const invocation = invocationMap.get(event.invocationId);
        if (invocation === undefined) continue;
        const source = parsed.data.data.source;
        const matches =
          input.record.origin === "runtime"
            ? source?.sessionId === input.record.sessionId
            : invocationIds.has(event.invocationId) && source?.parentSessionId === undefined;
        if (!matches) continue;
        records.push({
          sequence: event.cursor.sequence,
          sessionId: executionId,
          executionId,
          invocationId: event.invocationId,
          ...(invocation.parentInvocationId === undefined
            ? {}
            : { parentInvocationId: invocation.parentInvocationId }),
          ...(invocation.executorId === undefined ? {} : { executorId: invocation.executorId }),
          contextId: invocation.contextId,
          ...(parsed.data.data.runId === undefined ? {} : { runId: parsed.data.data.runId }),
          ...(parsed.data.data.parentRunId === undefined
            ? {}
            : { parentRunId: parsed.data.data.parentRunId }),
          ...(source === undefined ? {} : { source }),
          message: parsed.data.data.message,
        });
      }
    }
    return records.toSorted((left, right) => {
      const time = left.message.timestamp - right.message.timestamp;
      return time === 0
        ? `${left.executionId}:${left.sequence}`.localeCompare(
            `${right.executionId}:${right.sequence}`,
          )
        : time;
    });
  }

  async readRecordsAndOutput(input: {
    readonly executionIds: readonly string[];
    readonly rootSessionId?: string | undefined;
    readonly targetRecordId: string;
  }): Promise<{
    readonly records: readonly ExecutionWorkRecord[];
    readonly output: readonly AgentMessageRecord[];
  }> {
    const preloadedData = new Map<
      string,
      {
        readonly events: readonly import("@pragma/shared").ExecutionEvent[];
        readonly invocations: readonly Invocation[];
      }
    >();
    const records = await this.listRecords(
      { executionIds: input.executionIds, rootSessionId: input.rootSessionId },
      preloadedData,
    );
    const record = records.find((candidate) => candidate.recordId === input.targetRecordId);
    if (record === undefined) throw new Error(`Mission work record not found: ${input.targetRecordId}`);
    const output = await this.readOutput({ executionIds: input.executionIds, record }, preloadedData);
    return { records, output };
  }
}

function ensureRecord(
  records: Map<string, MutableWorkRecord>,
  input: Omit<MutableWorkRecord, "tasks">,
): MutableWorkRecord {
  const existing = records.get(input.recordId);
  if (existing !== undefined) {
    if (input.updatedAt > existing.updatedAt) existing.updatedAt = input.updatedAt;
    if (input.createdAt < existing.createdAt) existing.createdAt = input.createdAt;
    if (input.displayName !== undefined) existing.displayName = input.displayName;
    if (input.parentSessionId !== undefined) existing.parentSessionId = input.parentSessionId;
    return existing;
  }
  const created: MutableWorkRecord = { ...input, tasks: new Map() };
  records.set(input.recordId, created);
  return created;
}

function invocationTask(executionId: string, invocation: Invocation): ExecutionWorkTask {
  return {
    taskId: `${executionId}:${invocation.invocationId}`,
    executionId,
    invocationId: invocation.invocationId,
    runId: invocation.invocationId,
    ...(invocation.agentTaskSequence === undefined
      ? {}
      : { sequence: invocation.agentTaskSequence }),
    status: invocation.status,
    input: invocation.input,
    ...(invocation.output === undefined ? {} : { output: invocation.output }),
    ...(invocation.error === undefined ? {} : { error: invocation.error }),
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt,
  };
}

function putTask(record: MutableWorkRecord, task: ExecutionWorkTask): void {
  record.tasks.set(task.taskId, task);
  if (task.createdAt < record.createdAt) record.createdAt = task.createdAt;
  if (task.updatedAt > record.updatedAt) record.updatedAt = task.updatedAt;
}

function putRuntimeTask(
  record: MutableWorkRecord,
  executionId: string,
  invocationId: string,
  event: Extract<
    ReturnType<typeof ExpertAgentStreamEventSchema.parse>,
    { type: "run.started" | "run.completed" | "run.failed" | "run.cancelled" }
  >,
  order: number,
  dispatchedPrompt?: string | undefined,
): void {
  const taskId = `${executionId}:${event.runId}`;
  const current = record.tasks.get(taskId);
  const nextStatus = runtimeEventStatus(event.type);
  const status =
    current !== undefined && isTerminalStatus(current.status) && !isTerminalStatus(nextStatus)
      ? current.status
      : nextStatus;
  putTask(record, {
    ...current,
    taskId,
    executionId,
    invocationId,
    runId: event.runId,
    status,
    ...(event.type !== "run.started"
      ? {}
      : { input: dispatchedPrompt ?? current?.input ?? event.payload.task }),
    ...(event.type !== "run.failed" ? {} : { error: event.payload.message }),
    createdAt: current?.createdAt ?? event.emittedAt,
    updatedAt: event.emittedAt,
  });
  record.lastRuntimeRunOrder = order;
}

function applyRuntimeCommandStatus(
  record: MutableWorkRecord,
  event: Extract<ReturnType<typeof ExpertAgentStreamEventSchema.parse>, { type: "agent.command" }>,
  targetSessionId: string,
  order: number,
): void {
  const stateStatus = readRuntimeAgentStatus(event.payload.states?.[targetSessionId]);
  const status =
    stateStatus ??
    (event.payload.action === "interrupt" && event.payload.phase === "completed"
      ? "interrupted"
      : event.payload.phase === "failed"
        ? "failed"
        : undefined);
  if (status === undefined) return;
  const latestTask = [...record.tasks.values()].at(-1);
  if (status === "interrupted" && isTerminalStatus(latestTask?.status)) return;
  if (
    !isTerminalStatus(status) &&
    (isTerminalStatus(record.runtimeStatus) || isTerminalStatus(latestTask?.status))
  ) {
    return;
  }
  record.runtimeStatus = status;
  record.runtimeStatusOrder = order;
  if (event.emittedAt > record.updatedAt) record.updatedAt = event.emittedAt;
}

function runtimeEventStatus(
  type: "run.started" | "run.completed" | "run.failed" | "run.cancelled",
): ExecutionStatus {
  switch (type) {
    case "run.started":
      return "running";
    case "run.completed":
      return "succeeded";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
  }
}

function isRuntimeRunEvent(
  event: ReturnType<typeof ExpertAgentStreamEventSchema.parse>,
): event is Extract<
  ReturnType<typeof ExpertAgentStreamEventSchema.parse>,
  { type: "run.started" | "run.completed" | "run.failed" | "run.cancelled" }
> {
  return (
    event.type === "run.started" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}

function collectRuntimeDispatches(
  events: readonly RuntimeEventProjection[],
): ReadonlyMap<string, RuntimeDispatch> {
  const dispatches = new Map<string, RuntimeDispatch>();
  for (const { event } of events) {
    if (
      event.type !== "agent.command" ||
      (event.payload.action !== "spawn" && event.payload.action !== "send")
    ) {
      continue;
    }
    const current = dispatches.get(event.payload.commandId) ?? {
      commandId: event.payload.commandId,
      delivery: event.payload.delivery,
      targetSessionIds: new Set<string>(),
    };
    if (
      event.payload.prompt !== undefined &&
      (current.prompt === undefined || event.payload.prompt.length > current.prompt.length)
    ) {
      current.prompt = event.payload.prompt;
    }
    if (event.payload.delivery !== undefined) current.delivery = event.payload.delivery;
    for (const targetSessionId of event.payload.targetSessionIds) {
      current.targetSessionIds.add(targetSessionId);
    }
    dispatches.set(event.payload.commandId, current);
  }
  return dispatches;
}

function readRuntimeAgentStatus(value: unknown): ExecutionStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const status = (value as { status?: unknown }).status;
  switch (status) {
    case "pendingInit":
      return "queued";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
    case "shutdown":
      return "succeeded";
    case "errored":
    case "notFound":
      return "failed";
    default:
      return undefined;
  }
}

function finalizeRecord(record: MutableWorkRecord): ExecutionWorkRecord {
  const tasks = [...record.tasks.values()].toSorted((left, right) => {
    if (left.sequence !== undefined || right.sequence !== undefined) {
      return (left.sequence ?? 0) - (right.sequence ?? 0);
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
  return {
    recordId: record.recordId,
    kind: record.kind,
    sessionId: record.sessionId,
    ...(record.parentRecordId === undefined || record.parentRecordId === record.recordId
      ? {}
      : { parentRecordId: record.parentRecordId }),
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    ...(record.executorId === undefined ? {} : { executorId: record.executorId }),
    ...(record.contextId === undefined ? {} : { contextId: record.contextId }),
    origin: record.origin,
    status:
      record.origin === "runtime" &&
      record.runtimeStatus !== undefined &&
      (record.lastRuntimeRunOrder === undefined ||
        (record.runtimeStatusOrder ?? -1) > record.lastRuntimeRunOrder)
        ? record.runtimeStatus
        : record.origin === "runtime"
          ? aggregateRuntimeStatus(tasks)
          : aggregateStatus(tasks),
    tasks,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function aggregateStatus(tasks: readonly ExecutionWorkTask[]): ExecutionStatus {
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "waiting")) return "waiting";
  if (tasks.some((task) => task.status === "queued")) return "queued";
  return tasks.at(-1)?.status ?? "queued";
}

function aggregateRuntimeStatus(tasks: readonly ExecutionWorkTask[]): ExecutionStatus {
  return tasks.at(-1)?.status ?? "queued";
}

function isTerminalStatus(status: ExecutionStatus | undefined): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}
