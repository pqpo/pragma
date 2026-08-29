/** Lightweight runtime schemas for the Local Host-owned persistence family. */
export interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export interface MissionControllerLease {
  readonly schemaVersion: "pragma.local-host-mission-controller-lease/v1";
  readonly claimId: string;
  readonly fencingToken: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export interface MissionEvent {
  readonly schemaVersion: "pragma.local-host-mission-event/v1";
  readonly eventId: string;
  readonly missionId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface MissionOperationProjection {
  readonly schemaVersion: "pragma.local-host-mission-operation/v1";
  readonly operationId: string;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly commandId?: string;
  readonly kind: string;
  readonly state:
    "accepted" | "queued" | "applying" | "applied" | "rejected" | "expired" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly result?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
}

export interface MissionAggregateState {
  readonly schemaVersion: "pragma.local-host-mission-aggregate/v1";
  readonly missionId: string;
  readonly nextFencingToken: string;
  readonly eventSequence: number;
  readonly lease?: MissionControllerLease;
  readonly operations: Record<string, MissionOperationProjection>;
}

export interface RunRequestRegistry {
  readonly schemaVersion: "pragma.local-host-run-request-registry/v1";
  readonly requests: Record<
    string,
    { readonly payloadHash: string; readonly missionId: string; readonly createdAt: string }
  >;
}

export interface MissionCommandTransaction {
  readonly schemaVersion: "pragma.local-host-mission-command-transaction/v1";
  readonly missionId: string;
  readonly commandId: string;
  readonly command: unknown;
  readonly event: MissionEvent;
  readonly operation: MissionOperationProjection;
}

/** Durable two-file append used when a command first enters the Inbox. */
export interface MissionCommandAppendTransaction {
  readonly schemaVersion: "pragma.local-host-mission-command-append-transaction/v1";
  readonly missionId: string;
  readonly command: unknown;
  readonly operation: MissionOperationProjection;
}

/** Durable event/state-sequence append. */
export interface MissionEventTransaction {
  readonly schemaVersion: "pragma.local-host-mission-event-transaction/v1";
  readonly missionId: string;
  readonly event: MissionEvent;
}

/**
 * Host-provided mutations are represented as named, JSON-serializable
 * operations so a restarted Host can replay the Mission mutation before the
 * matching Local Host event is made visible.
 */
export interface MissionSemanticOperation {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface MissionSemanticWriteTransaction {
  readonly schemaVersion: "pragma.local-host-mission-semantic-write-transaction/v1";
  readonly missionId: string;
  readonly operation: MissionSemanticOperation;
  readonly event: MissionEvent;
}

/**
 * Crash journal for targeted retention compaction.  This is a new v1 journal
 * family; no existing aggregate, command, event, or operation schema version
 * is upgraded by retention.
 */
export interface MissionRetentionTransaction {
  readonly schemaVersion: "pragma.local-host-mission-retention-transaction/v1";
  readonly missionId: string;
  readonly eventSequence: number;
  readonly retainedEvents: readonly MissionEvent[];
  readonly retainedCommands: readonly unknown[];
  readonly removedOperations: readonly {
    readonly requestId: string;
    readonly operationId: string;
  }[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fence = /^[1-9][0-9]*$/;
const hash = /^sha256:[0-9a-f]{64}$/;
const operationStates = new Set([
  "accepted",
  "queued",
  "applying",
  "applied",
  "rejected",
  "expired",
  "failed",
]);

export const MissionControllerLeaseSchema: RuntimeSchema<MissionControllerLease> = {
  parse: parseLease,
};
export const MissionEventSchema: RuntimeSchema<MissionEvent> = { parse: parseEvent };
export const MissionOperationProjectionSchema: RuntimeSchema<MissionOperationProjection> = {
  parse: parseOperation,
};
export const MissionAggregateStateSchema: RuntimeSchema<MissionAggregateState> = {
  parse: parseAggregate,
};
export const RunRequestRegistrySchema: RuntimeSchema<RunRequestRegistry> = { parse: parseRegistry };
export const MissionCommandTransactionSchema: RuntimeSchema<MissionCommandTransaction> = {
  parse: parseTransaction,
};
export const MissionCommandAppendTransactionSchema: RuntimeSchema<MissionCommandAppendTransaction> =
  { parse: parseCommandAppendTransaction };
export const MissionEventTransactionSchema: RuntimeSchema<MissionEventTransaction> = {
  parse: parseEventTransaction,
};
export const MissionSemanticWriteTransactionSchema: RuntimeSchema<MissionSemanticWriteTransaction> =
  { parse: parseSemanticWriteTransaction };
export const MissionRetentionTransactionSchema: RuntimeSchema<MissionRetentionTransaction> = {
  parse: parseRetentionTransaction,
};

function parseLease(value: unknown): MissionControllerLease {
  const record = object(value, "Mission controller lease");
  exact(
    record,
    ["schemaVersion", "claimId", "fencingToken", "acquiredAt", "renewedAt", "expiresAt"],
    "Mission controller lease",
  );
  if (
    record.schemaVersion !== "pragma.local-host-mission-controller-lease/v1" ||
    !uuid.test(string(record.claimId, "claimId")) ||
    !fence.test(string(record.fencingToken, "fencingToken"))
  )
    throw invalid("Mission controller lease");
  return {
    schemaVersion: "pragma.local-host-mission-controller-lease/v1",
    claimId: string(record.claimId, "claimId"),
    fencingToken: string(record.fencingToken, "fencingToken"),
    acquiredAt: date(record.acquiredAt, "acquiredAt"),
    renewedAt: date(record.renewedAt, "renewedAt"),
    expiresAt: date(record.expiresAt, "expiresAt"),
  };
}

function parseEvent(value: unknown): MissionEvent {
  const record = object(value, "Mission event");
  exact(
    record,
    ["schemaVersion", "eventId", "missionId", "sequence", "occurredAt", "type", "data"],
    "Mission event",
  );
  if (
    record.schemaVersion !== "pragma.local-host-mission-event/v1" ||
    !uuid.test(string(record.eventId, "eventId")) ||
    !uuid.test(string(record.missionId, "missionId")) ||
    !Number.isInteger(record.sequence) ||
    (record.sequence as number) <= 0
  )
    throw invalid("Mission event");
  return {
    schemaVersion: "pragma.local-host-mission-event/v1",
    eventId: string(record.eventId, "eventId"),
    missionId: string(record.missionId, "missionId"),
    sequence: record.sequence as number,
    occurredAt: date(record.occurredAt, "occurredAt"),
    type: nonEmpty(record.type, "type"),
    data: object(record.data, "data"),
  };
}

function parseOperation(value: unknown): MissionOperationProjection {
  const record = object(value, "Mission operation");
  const allowed = [
    "schemaVersion",
    "operationId",
    "requestId",
    "payloadHash",
    "commandId",
    "kind",
    "state",
    "createdAt",
    "updatedAt",
    "result",
    "error",
  ];
  exact(record, allowed, "Mission operation", ["commandId", "result", "error"]);
  if (
    record.schemaVersion !== "pragma.local-host-mission-operation/v1" ||
    !uuid.test(string(record.operationId, "operationId")) ||
    !uuid.test(string(record.requestId, "requestId")) ||
    !hash.test(string(record.payloadHash, "payloadHash")) ||
    !operationStates.has(string(record.state, "state"))
  )
    throw invalid("Mission operation");
  const commandId = optionalUuid(record.commandId, "commandId");
  return {
    schemaVersion: "pragma.local-host-mission-operation/v1",
    operationId: string(record.operationId, "operationId"),
    requestId: string(record.requestId, "requestId"),
    payloadHash: string(record.payloadHash, "payloadHash"),
    ...(commandId === undefined ? {} : { commandId }),
    kind: nonEmpty(record.kind, "kind"),
    state: string(record.state, "state") as MissionOperationProjection["state"],
    createdAt: date(record.createdAt, "createdAt"),
    updatedAt: date(record.updatedAt, "updatedAt"),
    ...(record.result === undefined ? {} : { result: object(record.result, "result") }),
    ...(record.error === undefined ? {} : { error: object(record.error, "error") }),
  };
}

function parseAggregate(value: unknown): MissionAggregateState {
  const record = object(value, "Mission aggregate");
  exact(
    record,
    ["schemaVersion", "missionId", "nextFencingToken", "eventSequence", "lease", "operations"],
    "Mission aggregate",
    ["lease"],
  );
  if (
    record.schemaVersion !== "pragma.local-host-mission-aggregate/v1" ||
    !uuid.test(string(record.missionId, "missionId")) ||
    !fence.test(string(record.nextFencingToken, "nextFencingToken")) ||
    !Number.isInteger(record.eventSequence) ||
    (record.eventSequence as number) < 0
  )
    throw invalid("Mission aggregate");
  const operations = Object.fromEntries(
    Object.entries(object(record.operations, "operations")).map(([requestId, operation]) => {
      if (!uuid.test(requestId)) throw invalid("Mission aggregate operation key");
      return [requestId, parseOperation(operation)];
    }),
  );
  return {
    schemaVersion: "pragma.local-host-mission-aggregate/v1",
    missionId: string(record.missionId, "missionId"),
    nextFencingToken: string(record.nextFencingToken, "nextFencingToken"),
    eventSequence: record.eventSequence as number,
    ...(record.lease === undefined ? {} : { lease: parseLease(record.lease) }),
    operations: operations as Record<string, MissionOperationProjection>,
  };
}

function parseRegistry(value: unknown): RunRequestRegistry {
  const record = object(value, "Run request registry");
  exact(record, ["schemaVersion", "requests"], "Run request registry");
  if (record.schemaVersion !== "pragma.local-host-run-request-registry/v1")
    throw invalid("Run request registry");
  const requests = Object.fromEntries(
    Object.entries(object(record.requests, "requests")).map(([requestId, request]) => {
      const entry = object(request, "Run request");
      exact(entry, ["payloadHash", "missionId", "createdAt"], "Run request");
      const payloadHash = string(entry.payloadHash, "payloadHash");
      const missionId = string(entry.missionId, "missionId");
      if (!uuid.test(requestId) || !hash.test(payloadHash) || !uuid.test(missionId))
        throw invalid("Run request");
      return [requestId, { payloadHash, missionId, createdAt: date(entry.createdAt, "createdAt") }];
    }),
  ) as Record<
    string,
    { readonly payloadHash: string; readonly missionId: string; readonly createdAt: string }
  >;
  return { schemaVersion: "pragma.local-host-run-request-registry/v1", requests };
}

function parseTransaction(value: unknown): MissionCommandTransaction {
  const record = object(value, "Mission command transaction");
  exact(
    record,
    ["schemaVersion", "missionId", "commandId", "command", "event", "operation"],
    "Mission command transaction",
  );
  if (
    record.schemaVersion !== "pragma.local-host-mission-command-transaction/v1" ||
    !uuid.test(string(record.missionId, "missionId")) ||
    !uuid.test(string(record.commandId, "commandId"))
  )
    throw invalid("Mission command transaction");
  return {
    schemaVersion: "pragma.local-host-mission-command-transaction/v1",
    missionId: string(record.missionId, "missionId"),
    commandId: string(record.commandId, "commandId"),
    command: record.command,
    event: parseEvent(record.event),
    operation: parseOperation(record.operation),
  };
}

function parseCommandAppendTransaction(value: unknown): MissionCommandAppendTransaction {
  const record = object(value, "Mission command append transaction");
  exact(
    record,
    ["schemaVersion", "missionId", "command", "operation"],
    "Mission command append transaction",
  );
  if (
    record.schemaVersion !== "pragma.local-host-mission-command-append-transaction/v1" ||
    !uuid.test(string(record.missionId, "missionId"))
  )
    throw invalid("Mission command append transaction");
  return {
    schemaVersion: "pragma.local-host-mission-command-append-transaction/v1",
    missionId: string(record.missionId, "missionId"),
    command: record.command,
    operation: parseOperation(record.operation),
  };
}

function parseEventTransaction(value: unknown): MissionEventTransaction {
  const record = object(value, "Mission event transaction");
  exact(record, ["schemaVersion", "missionId", "event"], "Mission event transaction");
  if (
    record.schemaVersion !== "pragma.local-host-mission-event-transaction/v1" ||
    !uuid.test(string(record.missionId, "missionId"))
  )
    throw invalid("Mission event transaction");
  return {
    schemaVersion: "pragma.local-host-mission-event-transaction/v1",
    missionId: string(record.missionId, "missionId"),
    event: parseEvent(record.event),
  };
}

function parseSemanticWriteTransaction(value: unknown): MissionSemanticWriteTransaction {
  const record = object(value, "Mission semantic write transaction");
  exact(
    record,
    ["schemaVersion", "missionId", "operation", "event"],
    "Mission semantic write transaction",
  );
  const operation = object(record.operation, "Mission semantic operation");
  exact(operation, ["name", "input"], "Mission semantic operation");
  if (
    record.schemaVersion !== "pragma.local-host-mission-semantic-write-transaction/v1" ||
    !uuid.test(string(record.missionId, "missionId"))
  )
    throw invalid("Mission semantic write transaction");
  return {
    schemaVersion: "pragma.local-host-mission-semantic-write-transaction/v1",
    missionId: string(record.missionId, "missionId"),
    operation: { name: nonEmpty(operation.name, "name"), input: object(operation.input, "input") },
    event: parseEvent(record.event),
  };
}

function parseRetentionTransaction(value: unknown): MissionRetentionTransaction {
  const record = object(value, "Mission retention transaction");
  exact(
    record,
    [
      "schemaVersion",
      "missionId",
      "eventSequence",
      "retainedEvents",
      "retainedCommands",
      "removedOperations",
    ],
    "Mission retention transaction",
  );
  if (
    record.schemaVersion !== "pragma.local-host-mission-retention-transaction/v1" ||
    !uuid.test(string(record.missionId, "missionId")) ||
    !Number.isSafeInteger(record.eventSequence) ||
    (record.eventSequence as number) < 0 ||
    !Array.isArray(record.retainedEvents) ||
    !Array.isArray(record.retainedCommands) ||
    !Array.isArray(record.removedOperations)
  )
    throw invalid("Mission retention transaction");
  const removedOperations = record.removedOperations.map((item) => {
    const operation = object(item, "Mission retention operation removal");
    exact(operation, ["requestId", "operationId"], "Mission retention operation removal");
    if (!uuid.test(string(operation.requestId, "requestId")))
      throw invalid("Mission retention operation removal");
    if (!uuid.test(string(operation.operationId, "operationId")))
      throw invalid("Mission retention operation removal");
    return {
      requestId: string(operation.requestId, "requestId"),
      operationId: string(operation.operationId, "operationId"),
    };
  });
  return {
    schemaVersion: "pragma.local-host-mission-retention-transaction/v1",
    missionId: string(record.missionId, "missionId"),
    eventSequence: record.eventSequence as number,
    retainedEvents: record.retainedEvents.map((event) => parseEvent(event)),
    retainedCommands: record.retainedCommands,
    removedOperations,
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(label);
  return value as Record<string, unknown>;
}
function exact(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set(fields);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    fields.some((field) => !optional.includes(field) && !(field in record))
  )
    throw invalid(label);
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(label);
  return value;
}
function nonEmpty(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed.length === 0) throw invalid(label);
  return parsed;
}
function date(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (Number.isNaN(Date.parse(parsed))) throw invalid(label);
  return parsed;
}
function optionalUuid(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = string(value, label);
  if (!uuid.test(parsed)) throw invalid(label);
  return parsed;
}
function invalid(label: string): Error {
  return new Error(`Invalid ${label} persistence schema.`);
}
