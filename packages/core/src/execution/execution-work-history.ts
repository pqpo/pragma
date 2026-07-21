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
  createdAt: string;
  updatedAt: string;
}

export class ExecutionWorkHistoryReader {
  constructor(private readonly store: ExecutionStore) {}

  async listRecords(input: {
    readonly executionIds: readonly string[];
    readonly rootSessionId?: string | undefined;
  }): Promise<readonly ExecutionWorkRecord[]> {
    const records = new Map<string, MutableWorkRecord>();
    const recordByInvocationId = new Map<string, string>();
    const runtimeRecordBySessionId = new Map<string, string>();

    for (const executionId of input.executionIds) {
      const [execution, invocations, agents, events] = await Promise.all([
        this.store.get(executionId),
        this.store.listInvocations(executionId),
        this.store.listAgents(executionId),
        this.store.readEvents(executionId),
      ]);
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

      for (const event of events) {
        if (event.type !== "runtime.event") continue;
        const parsed = ExpertAgentStreamEventSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const streamEvent = parsed.data;
        const source = streamEvent.source;
        if (streamEvent.type === "agent.command") {
          for (const targetSessionId of streamEvent.payload.targetSessionIds) {
            const targetRecordId = `runtime-agent:${targetSessionId}`;
            const target = ensureRecord(records, {
              recordId: targetRecordId,
              kind: "runtime-agent",
              sessionId: targetSessionId,
              parentSessionId:
                streamEvent.payload.senderSessionId ?? source.sessionId ?? source.parentSessionId,
              ownerInvocationId: event.invocationId,
              origin: "runtime",
              createdAt: streamEvent.emittedAt,
              updatedAt: streamEvent.emittedAt,
            });
            runtimeRecordBySessionId.set(targetSessionId, targetRecordId);
            applyCommandState(target, executionId, event.invocationId, streamEvent);
          }
        }
        if (source.sessionId === undefined || source.parentSessionId === undefined) continue;
        const recordId = `runtime-agent:${source.sessionId}`;
        const record = ensureRecord(records, {
          recordId,
          kind: "runtime-agent",
          sessionId: source.sessionId,
          parentSessionId: source.parentSessionId,
          ownerInvocationId: event.invocationId,
          displayName: source.displayName,
          origin: "runtime",
          createdAt: streamEvent.emittedAt,
          updatedAt: streamEvent.emittedAt,
        });
        runtimeRecordBySessionId.set(source.sessionId, recordId);
        if (source.displayName !== undefined) record.displayName = source.displayName;
        putRuntimeTask(record, executionId, event.invocationId, streamEvent);
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

  async readOutput(input: {
    readonly executionIds: readonly string[];
    readonly record: ExecutionWorkRecord;
  }): Promise<readonly AgentMessageRecord[]> {
    const invocationIds = new Set(input.record.tasks.map((task) => task.invocationId));
    const records: AgentMessageRecord[] = [];
    for (const executionId of input.executionIds) {
      for (const event of await this.store.readEvents(executionId)) {
        if (event.type !== "invocation.message.appended") continue;
        const parsed = InvocationMessageAppendedEventSchema.safeParse(event);
        if (!parsed.success) continue;
        const invocation = await this.store.getInvocation(executionId, event.invocationId);
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
  event: ReturnType<typeof ExpertAgentStreamEventSchema.parse>,
): void {
  record.tasks.delete(`${executionId}:session:${record.sessionId}`);
  if (event.type.startsWith("run.") && event.runId !== record.sessionId) {
    record.tasks.delete(`${executionId}:${record.sessionId}`);
  }
  const taskId = `${executionId}:${event.runId}`;
  const current = record.tasks.get(taskId);
  const status = runtimeEventStatus(event.type) ?? current?.status ?? "running";
  putTask(record, {
    taskId,
    executionId,
    invocationId,
    runId: event.runId,
    status,
    ...(event.type !== "run.started" ? {} : { input: event.payload.task }),
    ...(event.type !== "run.failed" ? {} : { error: event.payload.message }),
    createdAt: current?.createdAt ?? event.emittedAt,
    updatedAt: event.emittedAt,
  });
}

function applyCommandState(
  record: MutableWorkRecord,
  executionId: string,
  invocationId: string,
  event: Extract<ReturnType<typeof ExpertAgentStreamEventSchema.parse>, { type: "agent.command" }>,
): void {
  const state = event.payload.states?.[record.sessionId];
  const status =
    readRuntimeAgentStatus(state) ?? (event.payload.phase === "failed" ? "failed" : "queued");
  const taskId = `${executionId}:session:${record.sessionId}`;
  const current = record.tasks.get(taskId);
  putTask(record, {
    taskId,
    executionId,
    invocationId,
    runId: record.sessionId,
    status,
    ...(event.payload.prompt === undefined ? {} : { input: event.payload.prompt }),
    ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
    createdAt: current?.createdAt ?? event.emittedAt,
    updatedAt: event.emittedAt,
  });
}

function runtimeEventStatus(type: string): ExecutionStatus | undefined {
  switch (type) {
    case "run.started":
      return "running";
    case "run.completed":
      return "succeeded";
    case "run.failed":
      return "failed";
    case "run.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
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
    status: aggregateStatus(tasks),
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
