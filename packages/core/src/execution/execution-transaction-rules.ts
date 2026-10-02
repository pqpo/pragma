import {
  AgentInstanceSchema,
  CanonicalEventEnvelopeSchema,
  ExecutionEventSchema,
  ExpertPromptInputSchema,
  InvocationSchema,
  RuntimeContextRecordSchema,
  isTerminalExecutionStatus,
  type AgentInstance,
  type CanonicalEventEnvelope,
  type ExecutionCursor,
  type ExecutionEvent,
  type ExecutionRecord,
  type Invocation,
  type InvocationTree,
  type RuntimeContextRecord,
} from "@pragma/shared";
import { createHash, randomUUID } from "node:crypto";
import { type CanonicalEventHandoff } from "./canonical-event-handoff.ts";
import {
  EXECUTION_RECOVERY_CLAIM_STATE_KEY,
  ExecutionFinalStatusConflictError,
  type ExecutionAgentPatch,
  type ExecutionCommitRequest,
  type ExecutionContextPatch,
  type ExecutionInvocationPatch,
  type NewExecutionEvent,
} from "./execution-store.ts";
import { sameRuntimeContextOrigin } from "./runtime-context-record.ts";
function applyAgentChanges(
  current: readonly AgentInstance[],
  puts: readonly AgentInstance[],
  patches: readonly ExecutionAgentPatch[],
  now: string,
): AgentInstance[] {
  const byId = new Map(current.map((agent) => [agent.agentId, agent]));
  for (const agent of puts) {
    if (byId.has(agent.agentId)) throw new Error(`Agent already exists: ${agent.agentId}`);
    byId.set(agent.agentId, AgentInstanceSchema.parse(agent));
  }
  for (const change of patches) {
    const agent = byId.get(change.agentId);
    if (agent === undefined) throw new Error(`Agent not found: ${change.agentId}`);
    byId.set(
      change.agentId,
      AgentInstanceSchema.parse({
        ...agent,
        ...change.patch,
        agentId: change.agentId,
        updatedAt: change.patch.updatedAt ?? now,
      }),
    );
  }
  return [...byId.values()];
}

function applyContextChanges(
  current: readonly RuntimeContextRecord[],
  puts: readonly RuntimeContextRecord[],
  patches: readonly ExecutionContextPatch[],
  now: string,
): RuntimeContextRecord[] {
  const byId = new Map(current.map((context) => [context.contextId, context]));
  for (const context of puts) {
    if (byId.has(context.contextId)) {
      throw new Error(`Runtime Context already exists: ${context.contextId}`);
    }
    byId.set(context.contextId, RuntimeContextRecordSchema.parse(context));
  }
  for (const change of patches) {
    const context = byId.get(change.contextId);
    if (context === undefined) throw new Error(`Runtime Context not found: ${change.contextId}`);
    const next = RuntimeContextRecordSchema.parse({
      ...context,
      ...change.patch,
      updatedAt: change.patch.updatedAt ?? now,
    });
    assertContextIdentity(context, next);
    byId.set(change.contextId, next);
  }
  return [...byId.values()];
}

function assertAgentContextBindings(
  agents: readonly AgentInstance[],
  contexts: readonly RuntimeContextRecord[],
  invocations: readonly Invocation[],
): void {
  for (const invocation of invocations) {
    if (
      isTerminalExecutionStatus(invocation.status) &&
      invocation.pendingExpertMessages.length > 0
    ) {
      throw new Error(
        `Terminal Invocation cannot retain pending Expert messages: ${invocation.invocationId}.`,
      );
    }
  }
  const contextById = new Map(contexts.map((context) => [context.contextId, context]));
  const invocationById = new Map(
    invocations.map((invocation) => [invocation.invocationId, invocation]),
  );
  const agentByOwnedContext = new Map<string, string>();
  for (const agent of agents) {
    const context = contextById.get(agent.contextId);
    if (context === undefined) {
      throw new Error(`Agent Runtime Context not found: ${agent.contextId}`);
    }
    if (context.expert.id !== agent.definition.id) {
      throw new Error(`Agent Runtime Context identity conflict: ${agent.contextId}`);
    }
    const key = `${agent.ownerContextId}\u0000${agent.contextId}`;
    const existing = agentByOwnedContext.get(key);
    if (existing !== undefined && existing !== agent.agentId) {
      throw new Error(`Runtime Context ${agent.contextId} already belongs to Agent ${existing}.`);
    }
    agentByOwnedContext.set(key, agent.agentId);
    if (agent.activeInvocationId !== undefined) {
      const active = invocationById.get(agent.activeInvocationId);
      if (active === undefined || active.agentId !== agent.agentId) {
        throw new Error(`Agent active Invocation binding conflict: ${agent.activeInvocationId}.`);
      }
      if (isTerminalExecutionStatus(active.status)) {
        throw new Error(`Agent active Invocation cannot be terminal: ${agent.activeInvocationId}.`);
      }
    }
  }
}

function assertContextIdentity(current: RuntimeContextRecord, next: RuntimeContextRecord): void {
  if (
    current.contextId !== next.contextId ||
    current.owner.type !== next.owner.type ||
    current.owner.ownerId !== next.owner.ownerId ||
    !sameRuntimeContextOrigin(current.origin, next.origin) ||
    current.expert.id !== next.expert.id ||
    next.runtime.runtimeId !== current.runtime.runtimeId ||
    next.runtime.revision !== current.runtime.revision ||
    next.runtime.fingerprint !== current.runtime.fingerprint
  ) {
    throw new Error(`Runtime Context identity cannot change: ${current.contextId}`);
  }
  if (current.lifecycle === "closed" && next.lifecycle !== "closed") {
    throw new Error(`Closed Runtime Context cannot be reopened: ${current.contextId}`);
  }
}

function applyInvocationChanges(
  current: readonly Invocation[],
  puts: readonly Invocation[],
  patches: readonly ExecutionInvocationPatch[],
  now: string,
): Invocation[] {
  const byId = new Map(current.map((invocation) => [invocation.invocationId, invocation]));
  for (const invocation of puts) {
    byId.set(invocation.invocationId, InvocationSchema.parse(invocation));
  }
  for (const change of patches) {
    const invocation = byId.get(change.invocationId);
    if (invocation === undefined) throw new Error(`Invocation not found: ${change.invocationId}`);
    const nextStatus = change.patch.status ?? invocation.status;
    byId.set(
      change.invocationId,
      InvocationSchema.parse({
        ...invocation,
        ...change.patch,
        ...(nextStatus === "waiting" ? {} : { waitReason: undefined }),
        invocationId: change.invocationId,
        updatedAt: change.patch.updatedAt ?? now,
      }),
    );
  }
  return [...byId.values()];
}

function assertFinalStatusTransitions(
  execution: ExecutionRecord,
  invocations: readonly Invocation[],
  request: ExecutionCommitRequest,
  allowInterruptedResume: boolean,
): void {
  assertFinalStatusTransition(
    `Execution ${execution.executionId}`,
    execution.status,
    request.executionPatch?.status,
    allowInterruptedResume,
  );
  const byId = new Map(invocations.map((invocation) => [invocation.invocationId, invocation]));
  for (const invocation of request.invocationPuts ?? []) {
    const current = byId.get(invocation.invocationId);
    if (current !== undefined) {
      assertFinalStatusTransition(
        `Invocation ${invocation.invocationId}`,
        current.status,
        invocation.status,
        allowInterruptedResume,
      );
    }
  }
  for (const change of request.invocationPatches ?? []) {
    const current = byId.get(change.invocationId);
    if (current !== undefined) {
      assertFinalStatusTransition(
        `Invocation ${change.invocationId}`,
        current.status,
        change.patch.status,
        allowInterruptedResume,
      );
    }
  }
}

function hasActiveRecoveryClaim(
  execution: ExecutionRecord,
  recoveryClaimId: string | undefined,
): boolean {
  if (recoveryClaimId === undefined) return false;
  const claim = execution.state[EXECUTION_RECOVERY_CLAIM_STATE_KEY];
  if (typeof claim !== "object" || claim === null) return false;
  const stored = claim as { readonly claimId?: unknown; readonly expiresAt?: unknown };
  return (
    stored.claimId === recoveryClaimId &&
    typeof stored.expiresAt === "string" &&
    Date.parse(stored.expiresAt) > Date.now()
  );
}

function assertFinalStatusTransition(
  subject: string,
  current: Invocation["status"],
  requested: Invocation["status"] | undefined,
  allowInterruptedResume: boolean,
): void {
  if (
    requested !== undefined &&
    isTerminalExecutionStatus(current) &&
    requested !== current &&
    !(
      allowInterruptedResume &&
      current === "interrupted" &&
      (requested === "queued" || requested === "running")
    )
  ) {
    throw new ExecutionFinalStatusConflictError(subject, current, requested);
  }
}

function materializeEvents(
  executionId: string,
  existingEvents: readonly ExecutionEvent[],
  inputs: readonly NewExecutionEvent[],
  now: string,
  initialSequence = 0,
): { readonly newEvents: ExecutionEvent[]; readonly requestedEvents: ExecutionEvent[] } {
  const byId = new Map(existingEvents.map((event) => [event.eventId, event]));
  const newEvents: ExecutionEvent[] = [];
  const requestedEvents: ExecutionEvent[] = [];
  let sequence = Math.max(initialSequence, existingEvents.at(-1)?.cursor.sequence ?? 0);

  for (const input of inputs) {
    const eventId = input.eventId ?? randomUUID();
    const existing = byId.get(eventId);
    if (existing !== undefined) {
      if (!sameEventInput(existing, input)) {
        throw new Error(`Execution event idempotency conflict: ${eventId}`);
      }
      requestedEvents.push(existing);
      continue;
    }
    const event = parseExecutionEvent({
      schemaVersion: "pragma.execution-event/v5",
      eventId,
      cursor: { executionId, sequence: ++sequence },
      executionId,
      invocationId: input.invocationId,
      type: input.type,
      data: input.data,
      occurredAt: input.occurredAt ?? now,
    });
    byId.set(eventId, event);
    newEvents.push(event);
    requestedEvents.push(event);
  }

  return { newEvents, requestedEvents };
}

function sameEventInput(event: ExecutionEvent, input: NewExecutionEvent): boolean {
  return (
    event.invocationId === input.invocationId &&
    event.type === input.type &&
    stableStringify(event.data) === stableStringify(input.data)
  );
}

function toCanonicalExecutionEvent(
  event: ExecutionEvent,
  transaction: CanonicalEventHandoff["transaction"],
): CanonicalEventEnvelope {
  const eventId = createHash("sha256")
    .update(JSON.stringify(["pragma.execution-event/v5", event.executionId, event.eventId]))
    .digest("hex");
  return CanonicalEventEnvelopeSchema.parse({
    schemaVersion: "pragma.canonical-event/v1",
    eventId,
    topic: "pragma.execution.event.committed",
    schemaRef: "pragma.execution-event/v5",
    sourceRef: {
      type: "pragma.execution-event",
      id: event.eventId,
      ownerRef: { type: "pragma.execution", id: event.executionId },
      cursor: String(event.cursor.sequence),
    },
    relatedRefs: canonicalEventRelatedRefs(event, transaction),
    correlationId: event.executionId,
    occurredAt: event.occurredAt,
    payload: event,
  });
}

function canonicalEventRelatedRefs(
  event: ExecutionEvent,
  transaction: CanonicalEventHandoff["transaction"],
) {
  const related = [
    {
      relation: "pragma.execution-root",
      ref: {
        type: canonicalDefinitionType(transaction.execution.definition.kind),
        id: transaction.execution.definition.id,
      },
    },
  ];
  const invocation = transaction.invocations.find(
    (candidate) => candidate.invocationId === event.invocationId,
  );
  const context =
    invocation === undefined
      ? undefined
      : transaction.contexts.find((candidate) => candidate.contextId === invocation.contextId);
  if (context !== undefined) {
    related.push({
      relation: "pragma.event-producer",
      ref: { type: "pragma.expert", id: context.expert.id },
    });
  }
  return related.filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) =>
          other.relation === candidate.relation &&
          other.ref.type === candidate.ref.type &&
          other.ref.id === candidate.ref.id,
      ) === index,
  );
}

function canonicalDefinitionType(kind: string): string {
  switch (kind) {
    case "expert":
      return "pragma.expert";
    case "expert-team":
      return "pragma.expert-team";
    case "flow":
      return "pragma.flow";
    case "task":
      return "pragma.task";
    case "human-task":
      return "pragma.human-task";
    default:
      return "pragma.definition";
  }
}

function assertExpertTurnRootPrompt(
  execution: ExecutionRecord,
  invocations: readonly Invocation[],
): void {
  if (execution.kind !== "expert-turn") return;
  const root = invocations.find(
    (invocation) => invocation.invocationId === execution.rootInvocationId,
  );
  if (root === undefined) {
    throw new Error(`Execution root Invocation is missing: ${execution.rootInvocationId}`);
  }
  if (!ExpertPromptInputSchema.safeParse(root.input).success) {
    throw new Error("Expert turn root Invocation input must be a structured Expert prompt.");
  }
}

function parseExecutionEvent(value: unknown): ExecutionEvent {
  return ExecutionEventSchema.parse(value);
}

function filterAfter<T extends { readonly cursor: ExecutionCursor }>(
  values: readonly T[],
  executionId: string,
  after?: ExecutionCursor,
): readonly T[] {
  if (after !== undefined && after.executionId !== executionId) {
    throw new Error(`Cursor belongs to another Execution: ${after.executionId}`);
  }
  return values.filter((value) => value.cursor.sequence > (after?.sequence ?? 0));
}

function buildTree(rootId: string, invocations: readonly Invocation[]): InvocationTree {
  const byId = new Map(invocations.map((invocation) => [invocation.invocationId, invocation]));
  const root = byId.get(rootId);
  if (root === undefined) throw new Error(`Root Invocation not found: ${rootId}`);
  const childrenByParent = new Map<string, Invocation[]>();
  for (const invocation of invocations) {
    if (invocation.parentInvocationId === undefined) continue;
    const children = childrenByParent.get(invocation.parentInvocationId) ?? [];
    children.push(invocation);
    childrenByParent.set(invocation.parentInvocationId, children);
  }
  const visit = (invocation: Invocation, ancestors: ReadonlySet<string>): InvocationTree => {
    if (ancestors.has(invocation.invocationId)) {
      throw new Error(`Invocation tree contains a cycle: ${invocation.invocationId}`);
    }
    const nextAncestors = new Set(ancestors).add(invocation.invocationId);
    return {
      invocation,
      children: (childrenByParent.get(invocation.invocationId) ?? []).map((child) =>
        visit(child, nextAncestors),
      ),
    };
  };
  return visit(root, new Set());
}

function commitSignature(request: ExecutionCommitRequest): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function stableStringify(value: unknown): string {
  return stringifyJsonValue(value, new Set<object>());
}

function stringifyJsonValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unsupportedExecutionValue(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw unsupportedExecutionValue(value);
  if (ancestors.has(value)) throw new Error("Execution values must not contain cycles.");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stringifyJsonValue(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null)
      throw unsupportedExecutionValue(value);
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stringifyJsonValue(entry, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function unsupportedExecutionValue(value: unknown): Error {
  const kind = value === null ? "null" : ((value as object)?.constructor?.name ?? typeof value);
  return new Error(`Execution values must be JSON-safe; received ${kind}.`);
}

export const executionTransactionRules = {
  applyInvocationChanges,
  applyAgentChanges,
  applyContextChanges,
  assertFinalStatusTransitions,
  assertAgentContextBindings,
  assertExpertTurnRootPrompt,
  hasActiveRecoveryClaim,
  materializeEvents,
  toCanonicalExecutionEvent,
  commitSignature,
  buildTree,
  filterAfter,
};
