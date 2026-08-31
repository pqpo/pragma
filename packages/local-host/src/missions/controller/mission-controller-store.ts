import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  createIntegrationError,
  FencingTokenSchema,
  MissionCommandSchema,
  type IntegrationError,
  type MissionCommand,
} from "@pragma/shared/integration";

import {
  MissionAggregateStateSchema,
  MissionCommandAppendTransactionSchema,
  MissionCommandInboxMigrationSchema,
  MissionCommandTransactionSchema,
  MissionControllerLeaseSchema,
  MissionEventSchema,
  MissionEventTransactionSchema,
  MissionOperationProjectionSchema,
  MissionRetentionTransactionSchema,
  RunRequestRegistrySchema,
  type MissionAggregateState,
  type MissionControllerLease,
  type MissionEvent,
  type MissionOperationProjection,
  type MissionSemanticOperation,
  type MissionSemanticWriteTransaction,
  MissionSemanticWriteTransactionSchema,
} from "./schemas.ts";
import {
  findMissionPinnedBinding,
  MISSION_PINNED_BINDING_EVENT_TYPE,
  MissionPinnedBindingSchema,
  sameMissionPinnedBinding,
  type MissionPinnedBinding,
} from "./pinned-binding.ts";
import {
  exceedsMissionRetentionBudget,
  planMissionRetention,
  resolveMissionRetentionPolicy,
  retentionReport,
  serializedRetentionBytes,
  type MissionRetentionOptions,
  type MissionRetentionPolicy,
  type MissionRetentionReport,
} from "./retention.ts";
import { MissionCommandV1Schema } from "./migrations/mission-command/schemas/v1.ts";

function parseStoredMissionCommand(value: unknown): MissionCommand {
  const current = MissionCommandSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = MissionCommandV1Schema.parse(value);
  return MissionCommandSchema.parse({
    ...legacy,
    schemaVersion: "pragma.mission-command/v2",
  });
}

/**
 * The Host mutation may already have happened and its durable semantic-write
 * journal still needs replay. Rejecting the Inbox command in that state would
 * lie about the lower-level execution, so the controller keeps it accepted
 * and retries it under the current owner fence.
 */
export class MissionSemanticWritePendingError extends Error {
  constructor(options: { readonly cause: unknown }) {
    super("Mission semantic write is pending durable replay.", options);
    this.name = "MissionSemanticWritePendingError";
  }
}

export interface MissionControllerGuard {
  readonly claimId: string;
  readonly fencingToken: string;
}

export interface MissionControllerLeaseGrant extends MissionControllerGuard {
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
}

export interface MissionControlClock {
  now(): Date;
}

export interface MissionCommandApplyResult {
  readonly result: Record<string, unknown>;
}

export interface MissionWatchBarrier {
  readonly snapshot: MissionAggregateState;
  /** Cursor for the exact event sequence observed under the same lock. */
  readonly cursor: string;
  readonly barrierSequence: number;
  readonly events: readonly MissionEvent[];
  /** Latest lifecycle event retained at this barrier, even when replay is 0. */
  readonly latestStatusEventType?: string | undefined;
}

interface WatchFileSignature {
  readonly bytes: bigint;
  readonly modifiedAtNs: bigint;
  readonly inode: bigint;
}

interface WatchBarrierCacheEntry {
  readonly eventFile: WatchFileSignature | undefined;
  readonly barrier: MissionWatchBarrier;
}

const WATCH_RECOVERY_MARKERS = new Set([
  ".command-inbox-migration.json",
  ".retention-transaction.json",
  ".command-append-transaction.json",
  ".command-transaction.json",
  ".event-transaction.json",
]);

export type MissionControllerJournalPhase =
  | "command-inbox-migration.prepare"
  | "command-inbox-migration.backup"
  | "command-inbox-migration.replace"
  | "command-inbox-migration.clear"
  | "command-append.prepare"
  | "command-append.command"
  | "command-append.operation"
  | "command-append.clear"
  | "command-outcome.prepare"
  | "command-outcome.command"
  | "command-outcome.event"
  | "command-outcome.state"
  | "command-outcome.clear"
  | "event.prepare"
  | "event.append"
  | "event.state-sequence"
  | "event.clear"
  | "semantic-write.prepare"
  | "semantic-write.mutation-commit"
  | "semantic-write.event-append"
  | "semantic-write.state-sequence"
  | "semantic-write.clear"
  | "retention.prepare"
  | "retention.events"
  | "retention.commands"
  | "retention.state"
  | "retention.clear";

export interface MissionCommandConsumer {
  /**
   * Validates strict targets against the current lower-level controller. It is
   * invoked before the command handler and must not enqueue a replacement turn.
   */
  validateStrictTarget?(input: {
    readonly command: MissionCommand;
    readonly guard: MissionControllerGuard;
  }): Promise<void>;
  /** Command handlers must be idempotent by commandId. */
  apply(input: {
    readonly command: MissionCommand;
    readonly guard: MissionControllerGuard;
  }): Promise<MissionCommandApplyResult>;
  /**
   * Schedules lower-level owner settlement after the durable command outcome
   * is committed. Implementations must not wait for Runtime work here: the
   * controller poller remains available for the next Inbox command.
   */
  afterOutcome?(input: {
    readonly command: MissionCommand;
    readonly guard: MissionControllerGuard;
    readonly state: "applied" | "rejected";
    readonly result?: Record<string, unknown> | undefined;
    readonly error?: IntegrationError | undefined;
  }): Promise<void> | void;
}

export type MissionControllerGuardSource = MissionControllerGuard | (() => MissionControllerGuard);

export interface MissionControllerStore {
  claim(input: {
    readonly missionId: string;
    readonly claimId: string;
    readonly leaseMs: number;
  }): Promise<MissionControllerLeaseGrant>;
  renew(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly leaseMs: number;
  }): Promise<MissionControllerLeaseGrant>;
  release(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
  }): Promise<void>;
  releaseAfterLowerLevel(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly releaseLowerLevel: () => Promise<void>;
  }): Promise<void>;
  assertWriteGuard(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
  }): Promise<void>;
  write<T>(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly operation: (context: {
      appendEvent: (
        type: string,
        data: Record<string, unknown>,
        eventId?: MissionEvent["eventId"],
      ) => Promise<MissionEvent>;
    }) => Promise<T>;
  }): Promise<T>;
  coordinateSemanticWrite<T>(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly operation: MissionSemanticOperation;
    readonly eventType: string;
    readonly eventData: Record<string, unknown>;
    readonly apply: () => Promise<T>;
  }): Promise<T>;
  recoverSemanticWrite(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly replay: (operation: MissionSemanticOperation) => Promise<void>;
  }): Promise<MissionSemanticOperation | undefined>;
  reserveRunRequest(input: { readonly requestId: string; readonly payloadHash: string }): Promise<{
    readonly missionId: string;
    readonly disposition: "reserved" | "existing";
  }>;
  /**
   * Atomically bind an already-owned Host Mission identity to a run request.
   * The registry entry shape intentionally remains the v1 request tuple; only
   * the source of the Mission ID differs from reserveRunRequest.
   */
  reserveAttachedRunRequest(input: {
    readonly requestId: string;
    readonly payloadHash: string;
    readonly missionId: string;
  }): Promise<{
    readonly missionId: string;
    readonly disposition: "reserved" | "existing";
  }>;
  readRunRequest(input: { readonly requestId: string }): Promise<
    | {
        readonly missionId: string;
        readonly payloadHash: string;
        readonly createdAt: string;
      }
    | undefined
  >;
  ensurePinnedBinding(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly binding: MissionPinnedBinding;
  }): Promise<{ readonly disposition: "appended" | "existing" }>;
  appendCommand(
    input: Omit<
      MissionCommand,
      "schemaVersion" | "commandId" | "state" | "createdAt" | "targetFencingToken"
    > & { readonly commandId?: string; readonly createdAt?: string },
  ): Promise<{ readonly command: MissionCommand; readonly operation: MissionOperationProjection }>;
  processNext(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly consumer: MissionCommandConsumer;
  }): Promise<MissionCommand | undefined>;
  expireCommands(input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
  }): Promise<number>;
  getOperation(input: {
    readonly missionId: string;
    readonly requestId: string;
  }): Promise<MissionOperationProjection | undefined>;
  /** Read the durable command envelope used to reconstruct an idempotent retry. */
  getCommand(input: {
    readonly missionId: string;
    readonly requestId: string;
  }): Promise<MissionCommand | undefined>;
  /** Reserve a non-Inbox durable operation such as Mission resume. */
  reserveOperation(input: {
    readonly missionId: string;
    readonly requestId: string;
    readonly payloadHash: string;
    readonly kind: string;
    readonly createdAt?: string | undefined;
  }): Promise<{
    readonly operation: MissionOperationProjection;
    readonly disposition: "reserved" | "existing";
  }>;
  /** Complete a previously reserved operation under the current owner fence. */
  completeOperation(input: {
    readonly missionId: string;
    readonly requestId: string;
    readonly payloadHash: string;
    readonly state: "applied" | "rejected" | "failed";
    readonly guard?: MissionControllerGuard | undefined;
    readonly result?: Record<string, unknown> | undefined;
    readonly error?: Record<string, unknown> | undefined;
  }): Promise<MissionOperationProjection>;
  waitOperation(input: {
    readonly missionId: string;
    readonly requestId: string;
    /** Maximum wall-clock time to wait for a terminal operation projection. */
    readonly timeoutMs?: number | undefined;
    /** Poll interval; each read acquires and releases the aggregate lock. */
    readonly pollIntervalMs?: number | undefined;
  }): Promise<MissionOperationProjection>;
  listOperations(input: {
    readonly missionId: string;
  }): Promise<readonly MissionOperationProjection[]>;
  /** Reads one atomic replay/snapshot barrier without acquiring a Mission lease. */
  readWatchBarrier(input: {
    readonly missionId: string;
    readonly after?: string | undefined;
    readonly replay?: number | undefined;
  }): Promise<MissionWatchBarrier>;
  /** Compacts only this Mission's retained event and terminal command tails. */
  compactRetention(input: { readonly missionId: string }): Promise<MissionRetentionReport>;
  readSnapshot(input: { readonly missionId: string; readonly after?: string }): Promise<{
    readonly snapshot: MissionAggregateState;
    readonly cursor: string;
    readonly events: readonly MissionEvent[];
  }>;
  startPolling(input: {
    readonly missionId: string;
    /** A getter lets a long-lived poller observe a renewed fencing token. */
    readonly guard: MissionControllerGuardSource;
    readonly consumer: MissionCommandConsumer;
    readonly onLeaseLost: () => Promise<void> | void;
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly jitter?: () => number;
  }): { stop(): Promise<void> };
}

export function createMissionControllerStore(options: {
  readonly missionsPath: string;
  readonly clock?: MissionControlClock;
  readonly retention?: MissionRetentionOptions | undefined;
  /** Test-only deterministic interruption hook for durable journal boundaries. */
  readonly onJournalPhase?:
    ((phase: MissionControllerJournalPhase) => Promise<void> | void) | undefined;
}): MissionControllerStore {
  const clock = options.clock ?? { now: () => new Date() };
  const retentionPolicy: MissionRetentionPolicy = resolveMissionRetentionPolicy(options.retention);
  const missionDirectory = (missionId: string) =>
    join(options.missionsPath, missionId, "local-host");
  const statePath = (missionId: string) => join(missionDirectory(missionId), "aggregate.json");
  const commandsPath = (missionId: string) =>
    join(missionDirectory(missionId), "command-inbox.json");
  const commandV1BackupPath = (missionId: string) =>
    join(missionDirectory(missionId), "command-inbox.v1.backup.json");
  const commandInboxMigrationPath = (missionId: string) =>
    join(missionDirectory(missionId), ".command-inbox-migration.json");
  const eventsPath = (missionId: string) => join(missionDirectory(missionId), "events.jsonl");
  const transactionPath = (missionId: string) =>
    join(missionDirectory(missionId), ".command-transaction.json");
  const commandAppendTransactionPath = (missionId: string) =>
    join(missionDirectory(missionId), ".command-append-transaction.json");
  const eventTransactionPath = (missionId: string) =>
    join(missionDirectory(missionId), ".event-transaction.json");
  const semanticWriteTransactionPath = (missionId: string) =>
    join(missionDirectory(missionId), ".semantic-write-transaction.json");
  const retentionTransactionPath = (missionId: string) =>
    join(missionDirectory(missionId), ".retention-transaction.json");
  const lockPath = (missionId: string) =>
    join(options.missionsPath, ".locks", `${missionId}.aggregate.lock`);
  const registryPath = join(options.missionsPath, ".local-host", "run-request-registry.json");
  const registryLock = join(options.missionsPath, ".locks", "run-request-registry.lock");
  const watchBarrierCache = new Map<string, WatchBarrierCacheEntry>();

  const now = (): string => clock.now().toISOString();
  const checkpoint = async (phase: MissionControllerJournalPhase): Promise<void> =>
    await options.onJournalPhase?.(phase);
  const withAggregateLock = async <T>(missionId: string, operation: () => Promise<T>): Promise<T> =>
    await withFileLock(lockPath(missionId), operation, { operation: "mission-aggregate" });

  const readState = async (missionId: string): Promise<MissionAggregateState> => {
    const raw = await readJsonIfExists(statePath(missionId));
    if (raw === undefined) {
      return MissionAggregateStateSchema.parse({
        schemaVersion: "pragma.local-host-mission-aggregate/v1",
        missionId,
        nextFencingToken: "1",
        eventSequence: 0,
        operations: {},
      });
    }
    return MissionAggregateStateSchema.parse(raw);
  };

  const writeState = async (missionId: string, state: MissionAggregateState): Promise<void> =>
    await writeJsonAtomically(statePath(missionId), MissionAggregateStateSchema.parse(state));

  const recoverCommandInboxMigration = async (missionId: string): Promise<void> => {
    const raw = await readJsonIfExists(commandInboxMigrationPath(missionId));
    if (raw === undefined) return;
    const migration = MissionCommandInboxMigrationSchema.parse(raw);
    if (migration.missionId !== missionId) {
      throw storageError("Command Inbox migration belongs to another Mission.");
    }
    for (const value of migration.sourceCommands) {
      const current = MissionCommandSchema.safeParse(value);
      if (!current.success) MissionCommandV1Schema.parse(value);
    }
    const migratedCommands = MissionCommandSchema.array().parse(migration.migratedCommands);
    if ((await readJsonIfExists(commandV1BackupPath(missionId))) === undefined) {
      await writeJsonAtomically(commandV1BackupPath(missionId), migration.sourceCommands);
      await checkpoint("command-inbox-migration.backup");
    }
    await writeJsonAtomically(commandsPath(missionId), migratedCommands);
    await checkpoint("command-inbox-migration.replace");
    await rm(commandInboxMigrationPath(missionId), { force: true });
    await checkpoint("command-inbox-migration.clear");
  };

  const readCommands = async (missionId: string): Promise<MissionCommand[]> => {
    const raw = await readJsonIfExists(commandsPath(missionId));
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return MissionCommandSchema.array().parse(raw);
    let migrated = false;
    const commands = raw.map((value) => {
      const current = MissionCommandSchema.safeParse(value);
      if (current.success) return current.data;
      const legacy = MissionCommandV1Schema.parse(value);
      migrated = true;
      return MissionCommandSchema.parse({
        ...legacy,
        schemaVersion: "pragma.mission-command/v2",
      });
    });
    if (migrated) {
      const migration = MissionCommandInboxMigrationSchema.parse({
        schemaVersion: "pragma.local-host-mission-command-inbox-migration/v1",
        missionId,
        sourceCommands: raw,
        migratedCommands: commands,
      });
      await writeJsonAtomically(commandInboxMigrationPath(missionId), migration);
      await checkpoint("command-inbox-migration.prepare");
      await recoverCommandInboxMigration(missionId);
    }
    return commands;
  };

  const writeCommands = async (
    missionId: string,
    commands: readonly MissionCommand[],
  ): Promise<void> =>
    await writeJsonAtomically(
      commandsPath(missionId),
      MissionCommandSchema.array().parse(commands),
    );

  const readEvents = async (missionId: string): Promise<MissionEvent[]> => {
    try {
      const contents = await readFile(eventsPath(missionId), "utf8");
      if (contents === "") return [];
      // A fsync-interrupted JSONL append can leave only the last record torn.
      // This helper is called under the aggregate lock, so repairing that tail
      // cannot race with a concurrent append. Complete malformed lines remain
      // storage corruption and deliberately fail closed below.
      const complete = contents.endsWith("\n")
        ? contents
        : contents.slice(0, contents.lastIndexOf("\n") + 1);
      if (complete !== contents)
        await truncate(eventsPath(missionId), Buffer.byteLength(complete, "utf8"));
      if (complete === "") return [];
      return complete
        .slice(0, -1)
        .split("\n")
        .map((line) => MissionEventSchema.parse(JSON.parse(line) as unknown));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
  };

  const appendEventUnlocked = async (
    missionId: string,
    state: MissionAggregateState,
    type: string,
    data: Record<string, unknown>,
    eventId: MissionEvent["eventId"] = randomUUID(),
  ): Promise<{ readonly state: MissionAggregateState; readonly event: MissionEvent }> => {
    const event = MissionEventSchema.parse({
      schemaVersion: "pragma.local-host-mission-event/v1",
      eventId,
      missionId,
      sequence: state.eventSequence + 1,
      occurredAt: now(),
      type,
      data,
    });
    const transaction = MissionEventTransactionSchema.parse({
      schemaVersion: "pragma.local-host-mission-event-transaction/v1",
      missionId,
      event,
    });
    await writeJsonAtomically(eventTransactionPath(missionId), transaction);
    await checkpoint("event.prepare");
    await recoverEventTransaction(missionId);
    const next = await readState(missionId);
    const persisted = (await readEvents(missionId)).find(
      (candidate) => candidate.eventId === eventId,
    );
    if (persisted === undefined) throw storageError("Event transaction did not persist its event.");
    return { state: next, event: persisted };
  };

  const appendEventAndAdvanceSequence = async (
    missionId: string,
    event: MissionEvent,
    phases: {
      readonly append: MissionControllerJournalPhase;
      readonly state: MissionControllerJournalPhase;
    },
  ): Promise<void> => {
    const events = await readEvents(missionId);
    if (!events.some((candidate) => candidate.eventId === event.eventId)) {
      await appendJsonLine(eventsPath(missionId), event);
      await checkpoint(phases.append);
    }
    const state = await readState(missionId);
    if (state.eventSequence < event.sequence) {
      await writeState(
        missionId,
        MissionAggregateStateSchema.parse({ ...state, eventSequence: event.sequence }),
      );
      await checkpoint(phases.state);
    }
  };

  const recoverEventTransaction = async (missionId: string): Promise<void> => {
    const raw = await readJsonIfExists(eventTransactionPath(missionId));
    if (raw === undefined) return;
    const transaction = MissionEventTransactionSchema.parse(raw);
    if (transaction.missionId !== missionId)
      throw storageError("Event transaction mission does not match its owner.");
    await appendEventAndAdvanceSequence(missionId, transaction.event, {
      append: "event.append",
      state: "event.state-sequence",
    });
    await rm(eventTransactionPath(missionId), { force: true });
    await checkpoint("event.clear");
  };

  const recoverRetentionTransaction = async (missionId: string): Promise<void> => {
    const raw = await readJsonIfExists(retentionTransactionPath(missionId));
    if (raw === undefined) return;
    const transaction = MissionRetentionTransactionSchema.parse(raw);
    if (transaction.missionId !== missionId)
      throw storageError("Retention transaction mission does not match its owner.");

    const state = await readState(missionId);
    if (state.eventSequence !== transaction.eventSequence) {
      throw storageError("Retention transaction does not match the Mission event sequence.");
    }
    const retainedEvents = transaction.retainedEvents.map((event) => {
      if (event.missionId !== missionId || event.sequence > transaction.eventSequence) {
        throw storageError("Retention transaction contains an event for the wrong Mission.");
      }
      return event;
    });
    const retainedCommands = transaction.retainedCommands.map(parseStoredMissionCommand);
    const currentEvents = await readEvents(missionId);
    if (!sameJsonArray(currentEvents, retainedEvents)) {
      await writeEventsAtomically(eventsPath(missionId), retainedEvents);
      await checkpoint("retention.events");
    }

    const currentCommands = await readCommands(missionId);
    if (!sameJsonArray(currentCommands, retainedCommands)) {
      await writeCommands(missionId, retainedCommands);
      await checkpoint("retention.commands");
    }

    const operations = { ...state.operations };
    let operationsChanged = false;
    for (const removed of transaction.removedOperations) {
      const operation = operations[removed.requestId];
      if (operation === undefined) continue;
      if (operation.operationId !== removed.operationId) {
        throw storageError("Retention transaction conflicts with a Mission operation.");
      }
      delete operations[removed.requestId];
      operationsChanged = true;
    }
    if (operationsChanged) {
      await writeState(missionId, MissionAggregateStateSchema.parse({ ...state, operations }));
      await checkpoint("retention.state");
    }
    await rm(retentionTransactionPath(missionId), { force: true });
    await checkpoint("retention.clear");
  };

  const recoverCommandAppendTransaction = async (missionId: string): Promise<void> => {
    const raw = await readJsonIfExists(commandAppendTransactionPath(missionId));
    if (raw === undefined) return;
    const transaction = MissionCommandAppendTransactionSchema.parse(raw);
    if (transaction.missionId !== missionId)
      throw storageError("Command append transaction mission does not match its owner.");
    const command = parseStoredMissionCommand(transaction.command);
    const commands = await readCommands(missionId);
    if (!commands.some((candidate) => candidate.commandId === command.commandId)) {
      await writeCommands(missionId, [...commands, command]);
      await checkpoint("command-append.command");
    }
    const state = await readState(missionId);
    const existing = state.operations[transaction.operation.requestId];
    if (existing === undefined) {
      await writeState(
        missionId,
        MissionAggregateStateSchema.parse({
          ...state,
          operations: {
            ...state.operations,
            [transaction.operation.requestId]: transaction.operation,
          },
        }),
      );
      await checkpoint("command-append.operation");
    } else if (existing.commandId !== transaction.operation.commandId) {
      throw storageError("Command append transaction conflicts with its operation.");
    }
    await rm(commandAppendTransactionPath(missionId), { force: true });
    await checkpoint("command-append.clear");
  };

  const recoverCommandTransaction = async (missionId: string): Promise<void> => {
    const raw = await readJsonIfExists(transactionPath(missionId));
    if (raw === undefined) return;
    const transaction = MissionCommandTransactionSchema.parse(raw);
    if (transaction.missionId !== missionId)
      throw storageError("Transaction mission does not match its owner.");
    const command = parseStoredMissionCommand(transaction.command);
    const commands = await readCommands(missionId);
    const index = commands.findIndex((candidate) => candidate.commandId === command.commandId);
    if (index < 0 || JSON.stringify(commands[index]) !== JSON.stringify(command)) {
      if (index >= 0) commands[index] = command;
      else commands.push(command);
      await writeCommands(missionId, commands);
      await checkpoint("command-outcome.command");
    }
    const events = await readEvents(missionId);
    if (!events.some((event) => event.eventId === transaction.event.eventId)) {
      await appendJsonLine(eventsPath(missionId), transaction.event);
      await checkpoint("command-outcome.event");
    }
    const state = await readState(missionId);
    const operations = {
      ...state.operations,
      [transaction.operation.requestId]: transaction.operation,
    };
    if (
      state.eventSequence < transaction.event.sequence ||
      JSON.stringify(state.operations[transaction.operation.requestId]) !==
        JSON.stringify(transaction.operation)
    ) {
      await writeState(
        missionId,
        MissionAggregateStateSchema.parse({
          ...state,
          eventSequence: Math.max(state.eventSequence, transaction.event.sequence),
          operations,
        }),
      );
      await checkpoint("command-outcome.state");
    }
    await rm(transactionPath(missionId), { force: true });
    await checkpoint("command-outcome.clear");
  };

  const recoverTransactions = async (missionId: string): Promise<void> => {
    await recoverCommandInboxMigration(missionId);
    await recoverRetentionTransaction(missionId);
    await recoverCommandAppendTransaction(missionId);
    await recoverCommandTransaction(missionId);
    await recoverEventTransaction(missionId);
  };

  const retentionMayNeedCompaction = async (
    missionId: string,
    state: MissionAggregateState,
  ): Promise<boolean> => {
    // These checks are intentionally conservative. A possible threshold
    // crossing falls through to the full planner; a definite under-budget
    // Mission avoids rereading/parsing all event and Inbox records on every
    // ordinary command outcome.
    if (state.eventSequence > retentionPolicy.events.maxCount) return true;
    if ((await fileSizeIfExists(eventsPath(missionId))) > retentionPolicy.events.maxBytes)
      return true;
    if (Object.keys(state.operations).length > retentionPolicy.terminalCommands.maxCount)
      return true;
    const commandBytes = await fileSizeIfExists(commandsPath(missionId));
    const operationBytes = Object.values(state.operations).reduce(
      (total, operation) => total + serializedRetentionBytes(operation),
      0,
    );
    return commandBytes + operationBytes > retentionPolicy.terminalCommands.maxBytes;
  };

  const compactRetentionUnlocked = async (
    missionId: string,
    options: { readonly force?: boolean } = {},
  ): Promise<MissionRetentionReport> => {
    const state = await readState(missionId);
    if (!options.force && !(await retentionMayNeedCompaction(missionId, state))) {
      return {
        compacted: false,
        retainedEventCount: 0,
        retainedCommandCount: 0,
        retainedOperationCount: 0,
        removedEventCount: 0,
        removedCommandCount: 0,
        removedOperationCount: 0,
      };
    }
    const events = await readEvents(missionId);
    const commands = await readCommands(missionId);
    if (!exceedsMissionRetentionBudget({ events, commands, state, policy: retentionPolicy })) {
      return {
        compacted: false,
        retainedEventCount: events.length,
        retainedCommandCount: commands.length,
        retainedOperationCount: Object.keys(state.operations).length,
        removedEventCount: 0,
        removedCommandCount: 0,
        removedOperationCount: 0,
      };
    }
    const plan = planMissionRetention({ events, commands, state, policy: retentionPolicy });
    const report = retentionReport(plan);
    if (!plan.changed) return report;
    const transaction = MissionRetentionTransactionSchema.parse({
      schemaVersion: "pragma.local-host-mission-retention-transaction/v1",
      missionId,
      eventSequence: state.eventSequence,
      retainedEvents: plan.retainedEvents,
      retainedCommands: plan.retainedCommands,
      removedOperations: Object.entries(state.operations)
        .filter(([requestId]) => plan.retainedOperations[requestId] === undefined)
        .map(([requestId, operation]) => ({
          requestId,
          operationId: operation.operationId,
        })),
    });
    await writeJsonAtomically(retentionTransactionPath(missionId), transaction);
    await checkpoint("retention.prepare");
    await recoverRetentionTransaction(missionId);
    return report;
  };

  const readWatchBarrierUnlocked = async (input: {
    readonly missionId: string;
    readonly after?: string | undefined;
    readonly replay?: number | undefined;
  }): Promise<MissionWatchBarrier> => {
    if (input.after !== undefined && input.replay !== undefined) {
      throw createIntegrationError({
        code: "INVALID_ARGUMENT",
        category: "usage",
        message: "Mission watch accepts either --after or --replay, not both.",
        details: { missionId: input.missionId },
      });
    }
    const replay = input.replay ?? 50;
    if (!Number.isSafeInteger(replay) || replay < 0 || replay > 1_000) {
      throw createIntegrationError({
        code: "INVALID_ARGUMENT",
        category: "usage",
        message: "Mission watch replay must be an integer between 0 and 1000.",
        details: { missionId: input.missionId, replay },
      });
    }
    await compactRetentionUnlocked(input.missionId);
    const snapshot = await readState(input.missionId);
    const allEvents = await readEvents(input.missionId);
    const after = input.after === undefined ? undefined : parseCursor(input.after, input.missionId);
    if (!allEvents.some((event) => event.type === "mission.created")) {
      throw createIntegrationError({
        code: "MISSION_NOT_FOUND",
        category: "not_found",
        message: `Mission not found: ${input.missionId}.`,
        details: { missionId: input.missionId },
      });
    }
    if (after !== undefined) assertCursorRetained(after, snapshot.eventSequence, allEvents);
    const events =
      after === undefined
        ? replay === 0
          ? []
          : allEvents.slice(Math.max(0, allEvents.length - replay))
        : allEvents.filter((event) => event.sequence > after);
    const barrier = {
      snapshot,
      cursor: makeCursor(input.missionId, snapshot.eventSequence),
      barrierSequence: snapshot.eventSequence,
      events,
      ...latestStatusEventType(allEvents),
    };
    watchBarrierCache.set(input.missionId, {
      eventFile: await readWatchFileSignature(eventsPath(input.missionId)),
      barrier,
    });
    return barrier;
  };

  /**
   * A following watcher already owns a valid cursor. When the durable event
   * file and recovery markers are unchanged, its last barrier is still a
   * valid empty barrier. Avoid reopening the aggregate lock and reparsing the
   * complete event log on every idle poll; a changed marker or file always
   * falls back to the locked path below.
   */
  const readCachedWatchBarrier = async (input: {
    readonly missionId: string;
    readonly after?: string | undefined;
    readonly replay?: number | undefined;
  }): Promise<MissionWatchBarrier | undefined> => {
    if (input.after === undefined || input.replay !== undefined) return undefined;
    const cached = watchBarrierCache.get(input.missionId);
    if (cached === undefined) return undefined;
    const after = parseCursor(input.after, input.missionId);
    if (after !== cached.barrier.barrierSequence) return undefined;
    if (await hasWatchRecoveryMarker(missionDirectory(input.missionId))) return undefined;
    if (
      !sameWatchFileSignature(
        cached.eventFile,
        await readWatchFileSignature(eventsPath(input.missionId)),
      )
    )
      return undefined;

    // Lease updates and other aggregate-only changes do not append an event.
    // Refresh the snapshot atomically-written file while retaining the cached
    // event barrier; a changed eventSequence forces the complete locked path.
    const snapshot = await readState(input.missionId);
    if (snapshot.eventSequence !== cached.barrier.barrierSequence) return undefined;
    return { ...cached.barrier, snapshot, events: [] };
  };

  const assertGuard = (
    state: MissionAggregateState,
    guard: MissionControllerGuard,
  ): MissionControllerLease => {
    const lease = state.lease;
    if (
      lease === undefined ||
      lease.claimId !== guard.claimId ||
      lease.fencingToken !== guard.fencingToken ||
      Date.parse(lease.expiresAt) <= clock.now().getTime()
    ) {
      throw fencingError();
    }
    return lease;
  };

  const updateCommandOutcome = async (input: {
    readonly missionId: string;
    readonly command: MissionCommand;
    readonly operation: MissionOperationProjection;
    readonly eventType:
      "command.accepted" | "command.applied" | "command.rejected" | "command.expired";
    readonly eventData: Record<string, unknown>;
  }): Promise<void> => {
    const state = await readState(input.missionId);
    const event = MissionEventSchema.parse({
      schemaVersion: "pragma.local-host-mission-event/v1",
      eventId: randomUUID(),
      missionId: input.missionId,
      sequence: state.eventSequence + 1,
      occurredAt: now(),
      type: input.eventType,
      data: input.eventData,
    });
    const transaction = MissionCommandTransactionSchema.parse({
      schemaVersion: "pragma.local-host-mission-command-transaction/v1",
      missionId: input.missionId,
      commandId: input.command.commandId,
      command: input.command,
      event,
      operation: input.operation,
    });
    await writeJsonAtomically(transactionPath(input.missionId), transaction);
    await checkpoint("command-outcome.prepare");
    await recoverCommandTransaction(input.missionId);
    await compactRetentionUnlocked(input.missionId);
  };

  const prepareSemanticWrite = async (input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly operation: MissionSemanticOperation;
    readonly eventType: string;
    readonly eventData: Record<string, unknown>;
  }): Promise<MissionSemanticWriteTransaction> =>
    await withAggregateLock(input.missionId, async () => {
      await recoverTransactions(input.missionId);
      const state = await readState(input.missionId);
      assertGuard(state, input.guard);
      if ((await readJsonIfExists(semanticWriteTransactionPath(input.missionId))) !== undefined)
        throw storageError(
          "A Mission semantic write transaction requires recovery before another write.",
        );
      const transaction = MissionSemanticWriteTransactionSchema.parse({
        schemaVersion: "pragma.local-host-mission-semantic-write-transaction/v1",
        missionId: input.missionId,
        operation: input.operation,
        event: {
          schemaVersion: "pragma.local-host-mission-event/v1",
          eventId: randomUUID(),
          missionId: input.missionId,
          // v1 transaction records require a positive event sequence. This
          // placeholder is deliberately ignored: the real sequence is
          // allocated only when the event is committed below.
          sequence: 1,
          occurredAt: now(),
          type: input.eventType,
          data: input.eventData,
        },
      });
      await writeJsonAtomically(semanticWriteTransactionPath(input.missionId), transaction);
      await checkpoint("semantic-write.prepare");
      return transaction;
    });

  const completeSemanticWrite = async (input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
    readonly transaction: MissionSemanticWriteTransaction;
  }): Promise<void> => {
    await withAggregateLock(input.missionId, async () => {
      await recoverTransactions(input.missionId);
      assertGuard(await readState(input.missionId), input.guard);
      const raw = await readJsonIfExists(semanticWriteTransactionPath(input.missionId));
      if (raw === undefined) return;
      const pending = MissionSemanticWriteTransactionSchema.parse(raw);
      if (
        pending.missionId !== input.missionId ||
        pending.event.eventId !== input.transaction.event.eventId
      ) {
        throw storageError("Mission semantic write transaction changed before completion.");
      }
      const events = await readEvents(input.missionId);
      const persisted = events.find((event) => event.eventId === pending.event.eventId);
      const event =
        persisted ??
        MissionEventSchema.parse({
          ...pending.event,
          sequence: (await readState(input.missionId)).eventSequence + 1,
        });
      if (persisted === undefined) {
        // Persist the committed sequence with the stable eventId before the
        // JSONL append. A crash before the append simply rebases again under
        // the aggregate lock; a crash after it recovers from the persisted
        // event's actual sequence.
        await writeJsonAtomically(
          semanticWriteTransactionPath(input.missionId),
          MissionSemanticWriteTransactionSchema.parse({ ...pending, event }),
        );
        await appendJsonLine(eventsPath(input.missionId), event);
        await checkpoint("semantic-write.event-append");
      }
      const state = await readState(input.missionId);
      if (state.eventSequence < event.sequence) {
        await writeState(
          input.missionId,
          MissionAggregateStateSchema.parse({ ...state, eventSequence: event.sequence }),
        );
        await checkpoint("semantic-write.state-sequence");
      }
      await rm(semanticWriteTransactionPath(input.missionId), { force: true });
      await checkpoint("semantic-write.clear");
    });
  };

  const readSemanticWriteForRecovery = async (input: {
    readonly missionId: string;
    readonly guard: MissionControllerGuard;
  }): Promise<MissionSemanticWriteTransaction | undefined> =>
    await withAggregateLock(input.missionId, async () => {
      await recoverTransactions(input.missionId);
      assertGuard(await readState(input.missionId), input.guard);
      const raw = await readJsonIfExists(semanticWriteTransactionPath(input.missionId));
      if (raw === undefined) return undefined;
      const transaction = MissionSemanticWriteTransactionSchema.parse(raw);
      if (transaction.missionId !== input.missionId)
        throw storageError("Mission semantic write transaction mission does not match its owner.");
      return transaction;
    });

  return {
    async claim(input) {
      assertLeaseDuration(input.leaseMs);
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        const current = state.lease;
        const time = now();
        if (
          current !== undefined &&
          Date.parse(current.expiresAt) > clock.now().getTime() &&
          current.claimId !== input.claimId
        ) {
          throw createIntegrationError({
            code: "MISSION_LEASE_HELD",
            category: "conflict",
            message: `Mission ${input.missionId} already has a controller lease.`,
            details: { missionId: input.missionId },
          });
        }
        const renewingOwnLease =
          current?.claimId === input.claimId &&
          Date.parse(current.expiresAt) > clock.now().getTime();
        const token = renewingOwnLease ? current.fencingToken : state.nextFencingToken;
        const lease = MissionControllerLeaseSchema.parse({
          schemaVersion: "pragma.local-host-mission-controller-lease/v1",
          claimId: input.claimId,
          fencingToken: token,
          acquiredAt: current?.claimId === input.claimId ? current.acquiredAt : time,
          renewedAt: time,
          expiresAt: new Date(clock.now().getTime() + input.leaseMs).toISOString(),
        });
        await writeState(
          input.missionId,
          MissionAggregateStateSchema.parse({
            ...state,
            lease,
            nextFencingToken: renewingOwnLease ? state.nextFencingToken : nextFencingToken(token),
          }),
        );
        return lease;
      });
    },
    async renew(input) {
      assertLeaseDuration(input.leaseMs);
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        const lease = assertGuard(state, input.guard);
        const renewed = MissionControllerLeaseSchema.parse({
          ...lease,
          renewedAt: now(),
          expiresAt: new Date(clock.now().getTime() + input.leaseMs).toISOString(),
        });
        await writeState(
          input.missionId,
          MissionAggregateStateSchema.parse({ ...state, lease: renewed }),
        );
        return renewed;
      });
    },
    async release(input) {
      await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        assertGuard(state, input.guard);
        const next = { ...state };
        delete next.lease;
        await writeState(input.missionId, MissionAggregateStateSchema.parse(next));
      });
    },
    async releaseAfterLowerLevel(input) {
      await input.releaseLowerLevel();
      await this.release({ missionId: input.missionId, guard: input.guard });
    },
    async assertWriteGuard(input) {
      await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        assertGuard(await readState(input.missionId), input.guard);
      });
    },
    async write(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        let state = await readState(input.missionId);
        assertGuard(state, input.guard);
        const result = await input.operation({
          appendEvent: async (type, data, eventId) => {
            const appended = await appendEventUnlocked(input.missionId, state, type, data, eventId);
            state = appended.state;
            return appended.event;
          },
        });
        await compactRetentionUnlocked(input.missionId);
        return result;
      });
    },
    async coordinateSemanticWrite(input) {
      const transaction = await prepareSemanticWrite(input);
      try {
        const result = await input.apply();
        await checkpoint("semantic-write.mutation-commit");
        await completeSemanticWrite({
          missionId: input.missionId,
          guard: input.guard,
          transaction,
        });
        return result;
      } catch (error) {
        throw new MissionSemanticWritePendingError({ cause: error });
      }
    },
    async recoverSemanticWrite(input) {
      const transaction = await readSemanticWriteForRecovery(input);
      if (transaction === undefined) return undefined;
      await input.replay(transaction.operation);
      await checkpoint("semantic-write.mutation-commit");
      await completeSemanticWrite({ missionId: input.missionId, guard: input.guard, transaction });
      return transaction.operation;
    },
    async reserveRunRequest(input) {
      return await withFileLock(
        registryLock,
        async () => {
          const raw = await readJsonIfExists(registryPath);
          const registry = RunRequestRegistrySchema.parse(
            raw ?? { schemaVersion: "pragma.local-host-run-request-registry/v1", requests: {} },
          );
          const existing = registry.requests[input.requestId];
          if (existing !== undefined) {
            if (existing.payloadHash !== input.payloadHash) throw idempotencyError(input.requestId);
            return { missionId: existing.missionId, disposition: "existing" as const };
          }
          const missionId = randomUUID();
          await writeJsonAtomically(
            registryPath,
            RunRequestRegistrySchema.parse({
              ...registry,
              requests: {
                ...registry.requests,
                [input.requestId]: {
                  payloadHash: input.payloadHash,
                  missionId,
                  createdAt: now(),
                },
              },
            }),
          );
          return { missionId, disposition: "reserved" as const };
        },
        { operation: "run-request-registry" },
      );
    },
    async reserveAttachedRunRequest(input) {
      return await withFileLock(
        registryLock,
        async () => {
          const raw = await readJsonIfExists(registryPath);
          const registry = RunRequestRegistrySchema.parse(
            raw ?? { schemaVersion: "pragma.local-host-run-request-registry/v1", requests: {} },
          );
          const existing = registry.requests[input.requestId];
          if (existing !== undefined) {
            if (
              existing.payloadHash !== input.payloadHash ||
              existing.missionId !== input.missionId
            ) {
              throw attachedIdempotencyError(input);
            }
            return await withAggregateLock(input.missionId, async () => {
              await recoverTransactions(input.missionId);
              await assertAttachedAggregateIdentity(input, await readState(input.missionId));
              await assertAttachedEventIdentity(input, await readEvents(input.missionId));
              return { missionId: input.missionId, disposition: "existing" as const };
            });
          }

          const occupied = Object.entries(registry.requests).find(
            ([, request]) => request.missionId === input.missionId,
          );
          if (occupied !== undefined) throw attachedIdempotencyError(input);

          return await withAggregateLock(input.missionId, async () => {
            await recoverTransactions(input.missionId);
            const state = await readState(input.missionId);
            const events = await readEvents(input.missionId);
            await assertAttachedAggregateIdentity(input, state);
            await assertAttachedEventIdentity(input, events);
            await writeJsonAtomically(
              registryPath,
              RunRequestRegistrySchema.parse({
                ...registry,
                requests: {
                  ...registry.requests,
                  [input.requestId]: {
                    payloadHash: input.payloadHash,
                    missionId: input.missionId,
                    createdAt: now(),
                  },
                },
              }),
            );
            return { missionId: input.missionId, disposition: "reserved" as const };
          });
        },
        { operation: "attached-run-request-registry" },
      );
    },
    async readRunRequest(input) {
      return await withFileLock(
        registryLock,
        async () => {
          const raw = await readJsonIfExists(registryPath);
          if (raw === undefined) return undefined;
          const registry = RunRequestRegistrySchema.parse(raw);
          return registry.requests[input.requestId];
        },
        { operation: "run-request-registry-read" },
      );
    },
    async ensurePinnedBinding(input) {
      const binding = MissionPinnedBindingSchema.parse(input.binding);
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        assertGuard(state, input.guard);
        const existing = findMissionPinnedBinding(await readEvents(input.missionId));
        if (existing !== undefined) {
          if (!sameMissionPinnedBinding(existing, binding)) {
            throw storageError("Mission contains a conflicting pinned binding.");
          }
          return { disposition: "existing" as const };
        }
        await appendEventUnlocked(
          input.missionId,
          state,
          MISSION_PINNED_BINDING_EVENT_TYPE,
          binding,
        );
        await compactRetentionUnlocked(input.missionId);
        return { disposition: "appended" as const };
      });
    },
    async appendCommand(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        const existing = state.operations[input.request.requestId];
        if (existing !== undefined) {
          if (existing.payloadHash !== input.request.payloadHash)
            throw idempotencyError(input.request.requestId);
          const commands = await readCommands(input.missionId);
          const command = commands.find(
            (candidate) => candidate.request.requestId === input.request.requestId,
          );
          if (command === undefined)
            throw storageError("Operation does not have its durable command.");
          return { command, operation: existing };
        }
        const strict = input.kind === "steer" || input.kind === "queue.steer";
        if (
          strict &&
          (input.target?.executionId === undefined || input.target.turnId === undefined)
        ) {
          throw createIntegrationError({
            code: "STEER_TARGET_NOT_ACTIVE",
            category: "conflict",
            message: "Strict steer requires expected executionId and turnId.",
            details: { missionId: input.missionId },
          });
        }
        if (strict && state.lease === undefined) {
          throw createIntegrationError({
            code: "STEER_TARGET_NOT_ACTIVE",
            category: "conflict",
            message: "Strict steer requires an active Mission controller.",
            details: { missionId: input.missionId },
          });
        }
        if (
          strict &&
          state.lease !== undefined &&
          Date.parse(state.lease.expiresAt) <= clock.now().getTime()
        ) {
          throw createIntegrationError({
            code: "STEER_TARGET_NOT_ACTIVE",
            category: "conflict",
            message: "Strict steer requires an active Mission controller.",
            details: { missionId: input.missionId },
          });
        }
        const createdAt = input.createdAt ?? now();
        const command = MissionCommandSchema.parse({
          ...input,
          schemaVersion: "pragma.mission-command/v2",
          commandId: input.commandId ?? randomUUID(),
          state: "pending",
          createdAt,
          ...(strict ? { targetFencingToken: state.lease!.fencingToken } : {}),
        });
        const operation = MissionOperationProjectionSchema.parse({
          schemaVersion: "pragma.local-host-mission-operation/v1",
          operationId: randomUUID(),
          requestId: command.request.requestId,
          payloadHash: command.request.payloadHash,
          commandId: command.commandId,
          kind: command.kind,
          state: "queued",
          createdAt,
          updatedAt: createdAt,
        });
        const transaction = MissionCommandAppendTransactionSchema.parse({
          schemaVersion: "pragma.local-host-mission-command-append-transaction/v1",
          missionId: input.missionId,
          command,
          operation,
        });
        await writeJsonAtomically(commandAppendTransactionPath(input.missionId), transaction);
        await checkpoint("command-append.prepare");
        await recoverCommandAppendTransaction(input.missionId);
        await compactRetentionUnlocked(input.missionId);
        return { command, operation };
      });
    },
    async processNext(input) {
      const selected = await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        assertGuard(state, input.guard);
        const commands = await readCommands(input.missionId);
        const command = commands.find(
          (candidate) => candidate.state === "pending" || candidate.state === "accepted",
        );
        if (command === undefined) return undefined;
        if (
          command.expiresAt !== undefined &&
          Date.parse(command.expiresAt) <= clock.now().getTime()
        ) {
          const operation = state.operations[command.request.requestId];
          if (operation === undefined)
            throw storageError("Expired command is missing its operation.");
          const expired = MissionCommandSchema.parse({
            ...command,
            state: "expired",
            acknowledgedAt: now(),
            appliedAt: now(),
            error: commandError("COMMAND_EXPIRED", "Command expired before an owner accepted it."),
          });
          const projection = MissionOperationProjectionSchema.parse({
            ...operation,
            state: "expired",
            updatedAt: now(),
            error: expired.error,
          });
          await updateCommandOutcome({
            missionId: input.missionId,
            command: expired,
            operation: projection,
            eventType: "command.expired",
            eventData: { commandId: command.commandId },
          });
          return undefined;
        }
        if (
          (command.kind === "steer" || command.kind === "queue.steer") &&
          command.targetFencingToken !== undefined &&
          command.targetFencingToken !== input.guard.fencingToken
        ) {
          const operation = state.operations[command.request.requestId];
          if (operation === undefined)
            throw storageError("Strict command is missing its operation.");
          const rejected = MissionCommandSchema.parse({
            ...command,
            state: "rejected",
            acknowledgedAt: now(),
            appliedAt: now(),
            error: commandError(
              "STEER_TARGET_CHANGED",
              "The strict steer target changed before it was accepted.",
            ),
          });
          const projection = MissionOperationProjectionSchema.parse({
            ...operation,
            state: "rejected",
            updatedAt: now(),
            error: rejected.error,
          });
          await updateCommandOutcome({
            missionId: input.missionId,
            command: rejected,
            operation: projection,
            eventType: "command.rejected",
            eventData: { commandId: command.commandId, error: rejected.error },
          });
          return undefined;
        }
        if (command.state === "accepted") return command;
        const accepted = MissionCommandSchema.parse({
          ...command,
          state: "accepted",
          acknowledgedAt: now(),
        });
        const operation = state.operations[accepted.request.requestId];
        if (operation === undefined)
          throw storageError("Accepted command is missing its operation.");
        const applying = MissionOperationProjectionSchema.parse({
          ...operation,
          state: "applying",
          updatedAt: now(),
        });
        await updateCommandOutcome({
          missionId: input.missionId,
          command: accepted,
          operation: applying,
          eventType: "command.accepted",
          eventData: { commandId: accepted.commandId },
        });
        return accepted;
      });
      if (selected === undefined) return undefined;
      let outcome:
        | {
            readonly state: "applied";
            readonly result: Record<string, unknown>;
          }
        | {
            readonly state: "rejected";
            readonly error: IntegrationError;
          }
        | undefined;
      try {
        if (selected.kind === "steer" || selected.kind === "queue.steer")
          await input.consumer.validateStrictTarget?.({ command: selected, guard: input.guard });
        const applied = await input.consumer.apply({ command: selected, guard: input.guard });
        let recorded = false;
        await withAggregateLock(input.missionId, async () => {
          await recoverTransactions(input.missionId);
          const state = await readState(input.missionId);
          assertGuard(state, input.guard);
          const command = (await readCommands(input.missionId)).find(
            (candidate) => candidate.commandId === selected.commandId,
          );
          const operation = state.operations[selected.request.requestId];
          if (command === undefined || operation === undefined)
            throw storageError("Accepted command disappeared before apply.");
          if (command.state === "applied") return;
          const completed = MissionCommandSchema.parse({
            ...command,
            state: "applied",
            appliedAt: now(),
          });
          const projection = MissionOperationProjectionSchema.parse({
            ...operation,
            state: "applied",
            updatedAt: now(),
            result: applied.result,
          });
          await updateCommandOutcome({
            missionId: input.missionId,
            command: completed,
            operation: projection,
            eventType: "command.applied",
            eventData: { commandId: completed.commandId },
          });
          recorded = true;
        });
        if (recorded) outcome = { state: "applied", result: applied.result };
      } catch (error) {
        if (error instanceof MissionSemanticWritePendingError) throw error;
        let recorded = false;
        const integrationError = toIntegrationError(error);
        await withAggregateLock(input.missionId, async () => {
          await recoverTransactions(input.missionId);
          const state = await readState(input.missionId);
          assertGuard(state, input.guard);
          const command = (await readCommands(input.missionId)).find(
            (candidate) => candidate.commandId === selected.commandId,
          );
          const operation = state.operations[selected.request.requestId];
          if (command === undefined || operation === undefined || command.state === "applied")
            return;
          const rejected = MissionCommandSchema.parse({
            ...command,
            state: "rejected",
            appliedAt: now(),
            error: integrationError,
          });
          const projection = MissionOperationProjectionSchema.parse({
            ...operation,
            state: "rejected",
            updatedAt: now(),
            error: integrationError,
          });
          await updateCommandOutcome({
            missionId: input.missionId,
            command: rejected,
            operation: projection,
            eventType: "command.rejected",
            eventData: { commandId: rejected.commandId, error: integrationError },
          });
          recorded = true;
        });
        if (recorded) outcome = { state: "rejected", error: integrationError };
      }
      if (outcome !== undefined && input.consumer.afterOutcome !== undefined) {
        // Settlement may wait for the lower-level execution to become idle;
        // never hold up the Inbox poller while that happens.
        void Promise.resolve()
          .then(
            async () =>
              await input.consumer.afterOutcome?.({
                command: selected,
                guard: input.guard,
                ...outcome,
              }),
          )
          .catch(() => undefined);
      }
      return selected;
    },
    async expireCommands(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        assertGuard(state, input.guard);
        let expired = 0;
        for (const command of await readCommands(input.missionId)) {
          if (
            command.state !== "pending" ||
            command.expiresAt === undefined ||
            Date.parse(command.expiresAt) > clock.now().getTime()
          )
            continue;
          const operation = (await readState(input.missionId)).operations[
            command.request.requestId
          ];
          if (operation === undefined)
            throw storageError("Expired command is missing its operation.");
          const outcome = MissionCommandSchema.parse({
            ...command,
            state: "expired",
            acknowledgedAt: now(),
            appliedAt: now(),
            error: commandError("COMMAND_EXPIRED", "Command expired before an owner accepted it."),
          });
          const projection = MissionOperationProjectionSchema.parse({
            ...operation,
            state: "expired",
            updatedAt: now(),
            error: outcome.error,
          });
          await updateCommandOutcome({
            missionId: input.missionId,
            command: outcome,
            operation: projection,
            eventType: "command.expired",
            eventData: { commandId: command.commandId },
          });
          expired += 1;
        }
        return expired;
      });
    },
    async getOperation(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        return (await readState(input.missionId)).operations[input.requestId];
      });
    },
    async getCommand(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        return (await readCommands(input.missionId)).find(
          (command) => command.request.requestId === input.requestId,
        );
      });
    },
    async reserveOperation(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        const existing = state.operations[input.requestId];
        if (existing !== undefined) {
          if (existing.payloadHash !== input.payloadHash) {
            throw idempotencyError(input.requestId);
          }
          return { operation: existing, disposition: "existing" as const };
        }
        const createdAt = input.createdAt ?? now();
        const operation = MissionOperationProjectionSchema.parse({
          schemaVersion: "pragma.local-host-mission-operation/v1",
          operationId: randomUUID(),
          requestId: input.requestId,
          payloadHash: input.payloadHash,
          kind: input.kind,
          state: "queued",
          createdAt,
          updatedAt: createdAt,
        });
        await writeState(
          input.missionId,
          MissionAggregateStateSchema.parse({
            ...state,
            operations: { ...state.operations, [input.requestId]: operation },
          }),
        );
        await compactRetentionUnlocked(input.missionId);
        return { operation, disposition: "reserved" as const };
      });
    },
    async completeOperation(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const state = await readState(input.missionId);
        if (input.guard !== undefined) assertGuard(state, input.guard);
        const existing = state.operations[input.requestId];
        if (existing === undefined) {
          throw storageError("Operation does not exist before completion.");
        }
        if (existing.payloadHash !== input.payloadHash) {
          throw idempotencyError(input.requestId);
        }
        if (isTerminalOperation(existing.state)) return existing;
        if (input.state === "applied" && input.result === undefined) {
          throw createIntegrationError({
            code: "INVALID_ARGUMENT",
            category: "usage",
            message: "Applied Mission operations require a result.",
          });
        }
        if (input.state !== "applied" && input.error === undefined) {
          throw createIntegrationError({
            code: "INVALID_ARGUMENT",
            category: "usage",
            message: "Rejected Mission operations require an error.",
          });
        }
        const operation = MissionOperationProjectionSchema.parse({
          ...existing,
          state: input.state,
          updatedAt: now(),
          ...(input.result === undefined ? {} : { result: input.result }),
          ...(input.error === undefined ? {} : { error: input.error }),
        });
        await writeState(
          input.missionId,
          MissionAggregateStateSchema.parse({
            ...state,
            operations: { ...state.operations, [input.requestId]: operation },
          }),
        );
        await compactRetentionUnlocked(input.missionId);
        return operation;
      });
    },
    async waitOperation(input) {
      const timeoutMs = input.timeoutMs ?? 30_000;
      const pollIntervalMs = input.pollIntervalMs ?? 100;
      assertWaitDuration(timeoutMs, "timeoutMs");
      assertWaitDuration(pollIntervalMs, "pollIntervalMs");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const operation = await this.getOperation({
          missionId: input.missionId,
          requestId: input.requestId,
        });
        if (operation !== undefined && isTerminalOperation(operation.state)) return operation;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(pollIntervalMs, remaining));
      }
      throw createIntegrationError({
        code: "COMMAND_ACK_TIMEOUT",
        category: "conflict",
        message: "Mission command acknowledgement timed out; the command remains durable.",
        details: {
          missionId: input.missionId,
          requestId: input.requestId,
          timeoutMs,
        },
      });
    },
    async listOperations(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        return Object.values((await readState(input.missionId)).operations).toSorted(
          (left, right) => left.createdAt.localeCompare(right.createdAt),
        );
      });
    },
    async readWatchBarrier(input) {
      const cached = await readCachedWatchBarrier(input);
      if (cached !== undefined) return cached;
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        return await readWatchBarrierUnlocked(input);
      });
    },
    async compactRetention(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        return await compactRetentionUnlocked(input.missionId, { force: true });
      });
    },
    async readSnapshot(input) {
      return await withAggregateLock(input.missionId, async () => {
        await recoverTransactions(input.missionId);
        const snapshot = await readState(input.missionId);
        const allEvents = await readEvents(input.missionId);
        const after =
          input.after === undefined ? undefined : parseCursor(input.after, input.missionId);
        if (after !== undefined) assertCursorRetained(after, snapshot.eventSequence, allEvents);
        const events =
          after === undefined ? allEvents : allEvents.filter((event) => event.sequence > after);
        return { snapshot, cursor: makeCursor(input.missionId, snapshot.eventSequence), events };
      });
    },
    startPolling(input) {
      const initialDelayMs = input.initialDelayMs ?? 500;
      const maxDelayMs = input.maxDelayMs ?? 2_000;
      if (initialDelayMs <= 0 || maxDelayMs < initialDelayMs)
        throw new Error("Invalid Mission inbox polling interval.");
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let delayMs = initialDelayMs;
      const schedule = (): void => {
        if (stopped) return;
        const jitter = Math.max(-0.25, Math.min(0.25, input.jitter?.() ?? 0));
        timer = setTimeout(() => void tick(), Math.round(delayMs * (1 + jitter)));
        timer.unref();
      };
      const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
          const guard = typeof input.guard === "function" ? input.guard() : input.guard;
          const command = await this.processNext({ ...input, guard });
          delayMs = command === undefined ? Math.min(maxDelayMs, delayMs * 2) : initialDelayMs;
          schedule();
        } catch (error) {
          if (isFencingError(error)) {
            stopped = true;
            await input.onLeaseLost();
            return;
          }
          schedule();
        }
      };
      schedule();
      return {
        stop: async () => {
          stopped = true;
          if (timer !== undefined) clearTimeout(timer);
        },
      };
    },
  };
}

function nextFencingToken(current: string): string {
  return FencingTokenSchema.parse((BigInt(current) + 1n).toString());
}

function fencingError(): IntegrationError {
  return createIntegrationError({
    code: "MISSION_FENCING_REJECTED",
    category: "conflict",
    message: "Mission controller lease was lost or superseded.",
  });
}

function assertLeaseDuration(leaseMs: number): void {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Mission controller leaseMs must be a finite positive number.",
    });
  }
}

function assertWaitDuration(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: `Mission operation ${name} must be a finite positive number.`,
    });
  }
}

function isTerminalOperation(state: MissionOperationProjection["state"]): boolean {
  return state === "applied" || state === "rejected" || state === "expired" || state === "failed";
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function idempotencyError(requestId: string): IntegrationError {
  return createIntegrationError({
    code: "IDEMPOTENCY_CONFLICT",
    category: "conflict",
    message: "requestId was already used with a different payload.",
    details: { requestId },
  });
}

function attachedIdempotencyError(input: {
  readonly requestId: string;
  readonly payloadHash: string;
  readonly missionId: string;
}): IntegrationError {
  return createIntegrationError({
    code: "IDEMPOTENCY_CONFLICT",
    category: "conflict",
    message: "The attached Mission identity does not match its existing run request.",
    details: {
      requestId: input.requestId,
      missionId: input.missionId,
    },
  });
}

function assertAttachedAggregateIdentity(
  input: { readonly missionId: string },
  state: MissionAggregateState,
): void {
  if (state.missionId !== input.missionId) {
    throw storageError("The attached Mission aggregate identity does not match its path.");
  }
}

function assertAttachedEventIdentity(
  input: {
    readonly requestId: string;
    readonly payloadHash: string;
    readonly missionId: string;
  },
  events: readonly MissionEvent[],
): void {
  for (const event of events) {
    if (event.missionId !== input.missionId) {
      throw storageError("The attached Mission event identity does not match its aggregate.");
    }
  }

  const createdEvents = events.filter((event) => event.type === "mission.created");
  if (createdEvents.length > 1) {
    throw storageError("A Mission contains duplicate creation anchors.");
  }
  const created = createdEvents[0];
  if (created !== undefined) {
    const requestId = created.data["requestId"];
    const payloadHash = created.data["payloadHash"];
    if (typeof requestId !== "string" || typeof payloadHash !== "string") {
      throw storageError("The attached Mission creation anchor is malformed.");
    }
    if (requestId !== input.requestId || payloadHash !== input.payloadHash) {
      throw attachedIdempotencyError(input);
    }
  }

  const binding = findMissionPinnedBinding(events);
  if (binding === undefined) return;
  if (created === undefined) {
    throw storageError("A Mission pinned binding is missing its creation anchor.");
  }
  if (binding.requestId !== input.requestId || binding.payloadHash !== input.payloadHash) {
    throw attachedIdempotencyError(input);
  }
}

function commandError(
  code: "COMMAND_EXPIRED" | "STEER_TARGET_CHANGED",
  message: string,
): IntegrationError {
  return createIntegrationError({ code, category: "conflict", message });
}

function storageError(message: string): IntegrationError {
  return createIntegrationError({ code: "STORAGE_CORRUPTED", category: "protocol", message });
}

function toIntegrationError(error: unknown): IntegrationError {
  if (isIntegrationError(error)) return error;
  return createIntegrationError({
    code: "COMMAND_REJECTED",
    category: "conflict",
    message: error instanceof Error ? error.message : "Command handler rejected the command.",
  });
}

function isIntegrationError(error: unknown): error is IntegrationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "schemaVersion" in error &&
    (error as { readonly schemaVersion?: unknown }).schemaVersion === "pragma.integration-error/v1"
  );
}

function isFencingError(error: unknown): boolean {
  return isIntegrationError(error) && error.code === "MISSION_FENCING_REJECTED";
}

export function makeMissionEventCursor(missionId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ missionId, sequence }), "utf8").toString("base64url");
}

export function parseMissionEventCursor(cursor: string, missionId: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      missionId?: unknown;
      sequence?: unknown;
    };
    const sequence = value.sequence;
    if (
      value.missionId !== missionId ||
      !Number.isInteger(sequence) ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      throw new Error("invalid");
    return sequence;
  } catch {
    throw createIntegrationError({
      code: "CURSOR_INVALID",
      category: "usage",
      message: "Mission event cursor is invalid.",
    });
  }
}

function makeCursor(missionId: string, sequence: number): string {
  return makeMissionEventCursor(missionId, sequence);
}

function parseCursor(cursor: string, missionId: string): number {
  return parseMissionEventCursor(cursor, missionId);
}

function assertCursorRetained(
  after: number,
  eventSequence: number,
  events: readonly MissionEvent[],
): void {
  if (after > eventSequence) {
    throw createIntegrationError({
      code: "CURSOR_INVALID",
      category: "usage",
      message: "Mission event cursor is ahead of the current Mission barrier.",
      details: { eventSequence },
    });
  }
  if (after === eventSequence) return;
  const next = events.find((event) => event.sequence > after);
  if (next === undefined || next.sequence !== after + 1) {
    throw createIntegrationError({
      code: "CURSOR_EXPIRED",
      category: "conflict",
      message: "Mission event cursor is earlier than the retained event window.",
      details: {
        after,
        eventSequence,
        ...(next === undefined ? {} : { nextSequence: next.sequence }),
      },
    });
  }
}

function latestStatusEventType(events: readonly MissionEvent[]): {
  readonly latestStatusEventType?: string | undefined;
} {
  const event = [...events].toReversed().find((candidate) => isStatusEventType(candidate.type));
  return event === undefined ? {} : { latestStatusEventType: event.type };
}

function isStatusEventType(type: string): boolean {
  return new Set([
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
  ]).has(type);
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function fileSizeIfExists(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw error;
  }
}

async function readWatchFileSignature(path: string): Promise<WatchFileSignature | undefined> {
  try {
    const details = await stat(path, { bigint: true });
    return {
      bytes: details.size,
      modifiedAtNs: details.mtimeNs,
      inode: details.ino,
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function sameWatchFileSignature(
  left: WatchFileSignature | undefined,
  right: WatchFileSignature | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.bytes === right.bytes &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.inode === right.inode
  );
}

async function hasWatchRecoveryMarker(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory);
    return entries.some((entry) => WATCH_RECOVERY_MARKERS.has(entry));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeEventsAtomically(path: string, events: readonly MissionEvent[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    const contents = events.map((event) => JSON.stringify(event)).join("\n");
    await handle.writeFile(contents.length === 0 ? "" : `${contents}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function sameJsonArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
