import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

import {
  AgentInstanceSchema,
  CanonicalEventEnvelopeSchema,
  ExecutionEventSchema,
  ExecutionRecordSchema,
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
import { z } from "zod";

import { withFileLock } from "../storage/file-lock.ts";
import type { CanonicalEventFeed } from "../events/canonical-event-feed.ts";
import {
  ExecutionCommitJournalSchema,
  executionCommitJournalMigrationChain,
  type ExecutionCommitJournal,
} from "../storage/migrations/execution-transaction/index.ts";
import {
  executionRecordMigrationChain,
  migrateExecutionInvocationsV5ToV6,
  migrateExecutionInvocationsV9ToV10,
  migrateInvocationUsageV7ToV8,
} from "../storage/migrations/execution/index.ts";
import { encodePragmaPathSegment, PragmaPaths } from "../storage/pragma-paths.ts";
import {
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
} from "../storage/state-migration.ts";
import { getExecutionLiveBus } from "./execution-live-bus.ts";
import { sameRuntimeContextOrigin } from "./runtime-context-record.ts";
import {
  CanonicalEventHandoffSchema,
  type CanonicalEventHandoff,
} from "./canonical-event-handoff.ts";

export const EXECUTION_RECOVERY_CLAIM_STATE_KEY = "__recoveryClaim";

export interface NewExecutionEvent {
  readonly eventId?: string | undefined;
  readonly invocationId: string;
  readonly type: string;
  readonly data: unknown;
  readonly occurredAt?: string | undefined;
}

export interface ExecutionInvocationPatch {
  readonly invocationId: string;
  readonly patch: Partial<Invocation>;
}

export interface ExecutionAgentPatch {
  readonly agentId: string;
  readonly patch: Partial<AgentInstance>;
}

export interface ExecutionContextPatch {
  readonly contextId: string;
  readonly patch: Partial<RuntimeContextRecord>;
}

export interface ExecutionCommitRequest {
  readonly commitId: string;
  readonly executionId: string;
  readonly expectedVersion?: number | undefined;
  readonly recoveryClaimId?: string | undefined;
  readonly executionPatch?: Partial<ExecutionRecord> | undefined;
  readonly invocationPuts?: readonly Invocation[] | undefined;
  readonly invocationPatches?: readonly ExecutionInvocationPatch[] | undefined;
  readonly agentPuts?: readonly AgentInstance[] | undefined;
  readonly agentPatches?: readonly ExecutionAgentPatch[] | undefined;
  readonly contextPuts?: readonly RuntimeContextRecord[] | undefined;
  readonly contextPatches?: readonly ExecutionContextPatch[] | undefined;
  readonly events?: readonly NewExecutionEvent[] | undefined;
}

export interface ExecutionCommitResult {
  readonly execution: ExecutionRecord;
  readonly invocations: readonly Invocation[];
  readonly agents: readonly AgentInstance[];
  readonly contexts: readonly RuntimeContextRecord[];
  readonly events: readonly ExecutionEvent[];
}

export class ExecutionVersionConflictError extends Error {
  constructor(expected: number, received: number) {
    super(`Execution version conflict: expected ${expected}, received ${received}.`);
    this.name = "ExecutionVersionConflictError";
  }
}

export class ExecutionFinalStatusConflictError extends Error {
  constructor(subject: string, current: string, requested: string) {
    super(`${subject} is already ${current} and cannot transition to ${requested}.`);
    this.name = "ExecutionFinalStatusConflictError";
  }
}

export class ExecutionHistoryUnavailableError extends Error {
  constructor(readonly executionId: string) {
    super(`Execution diagnostic history is unavailable: ${executionId}.`);
    this.name = "ExecutionHistoryUnavailableError";
  }
}

export interface ExecutionStore {
  create(record: ExecutionRecord, root: Invocation): Promise<void>;
  get(executionId: string): Promise<ExecutionRecord | undefined>;
  update(executionId: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord>;
  commit(request: ExecutionCommitRequest): Promise<ExecutionCommitResult>;
  claimRecovery(executionId: string, claimId: string, leaseMs: number): Promise<boolean>;
  getInvocation(executionId: string, invocationId: string): Promise<Invocation | undefined>;
  listInvocations(executionId: string): Promise<readonly Invocation[]>;
  getAgent(executionId: string, agentId: string): Promise<AgentInstance | undefined>;
  listAgents(executionId: string): Promise<readonly AgentInstance[]>;
  getContext(executionId: string, contextId: string): Promise<RuntimeContextRecord | undefined>;
  listContexts(executionId: string): Promise<readonly RuntimeContextRecord[]>;
  putInvocation(executionId: string, invocation: Invocation): Promise<void>;
  getTree(executionId: string): Promise<InvocationTree | undefined>;
  appendEvent(
    executionId: string,
    invocationId: string,
    type: string,
    data: unknown,
    eventId?: string,
  ): Promise<ExecutionEvent>;
  readEvents(executionId: string, after?: ExecutionCursor): Promise<readonly ExecutionEvent[]>;
  delete(executionId: string): Promise<void>;
  archive(executionId: string): Promise<void>;
}

export interface FileExecutionStore extends ExecutionStore {
  recoverPendingCanonicalEvents(input?: {
    readonly limit?: number | undefined;
  }): Promise<CanonicalEventRecoveryResult>;
  inspectCanonicalEventDelivery(): Promise<CanonicalEventDeliveryStatus>;
}

export interface CanonicalEventRecoveryResult {
  readonly recovered: number;
  readonly pending: number;
  readonly failed: number;
  readonly quarantined: number;
}

export interface CanonicalEventDeliveryStatus {
  readonly pending: number;
  readonly quarantined: number;
}

const ExecutionCommitRecordSchema = z.object({
  commitId: z.string().min(1),
  signature: z.string().length(64),
  eventIds: z.array(z.string().min(1)),
  committedVersion: z.number().int().nonnegative(),
});

type ExecutionCommitRecord = z.infer<typeof ExecutionCommitRecordSchema>;

export function createFileExecutionStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly canonicalEventFeed?: CanonicalEventFeed | undefined;
    readonly onCanonicalEventDeliveryError?:
      | ((
          error: unknown,
          context: {
            readonly executionId: string;
            readonly commitId: string;
            readonly handoffPath?: string | undefined;
          },
        ) => void)
      | undefined;
  } = {},
): FileExecutionStore {
  const paths = new PragmaPaths(options);
  const withExecutionLock = async <TValue>(
    executionId: string,
    operation: string,
    action: () => Promise<TValue>,
  ): Promise<TValue> =>
    await withFileLock(paths.executionLock(executionId), action, {
      operation: `execution.${operation}`,
    });

  const store: FileExecutionStore = {
    async recoverPendingCanonicalEvents(input = {}) {
      if (options.canonicalEventFeed === undefined) {
        return { recovered: 0, pending: 0, failed: 0, quarantined: 0 };
      }
      const files = await listCanonicalHandoffFiles(paths);
      const selected = files.slice(0, input.limit ?? 1_000);
      const executionIds = new Set<string>();
      let recovered = 0;
      let failed = 0;
      for (const file of selected) {
        try {
          const handoff = await readCanonicalHandoff(file);
          assertCanonicalHandoffFileOwner(file, handoff.executionId);
          executionIds.add(handoff.executionId);
        } catch (error) {
          failed += 1;
          const quarantinedPath = await quarantineCanonicalHandoff(paths, file);
          options.onCanonicalEventDeliveryError?.(error, {
            executionId: "unknown",
            commitId: "unknown",
            handoffPath: quarantinedPath,
          });
        }
      }
      for (const executionId of executionIds) {
        if (
          (await listQuarantinedCanonicalHandoffFilesForExecution(paths, executionId)).length > 0
        ) {
          continue;
        }
        try {
          const result = await withExecutionLock(
            executionId,
            "recover-canonical-events",
            async () =>
              recoverCanonicalHandoffsForExecution(paths, executionId, options.canonicalEventFeed!),
          );
          recovered += result.recovered;
          if (result.deliveryFailure !== undefined) {
            failed += 1;
            options.onCanonicalEventDeliveryError?.(result.deliveryFailure.error, {
              executionId,
              commitId: result.deliveryFailure.handoff.commitId,
              handoffPath: result.deliveryFailure.file,
            });
          }
        } catch (error) {
          failed += 1;
          options.onCanonicalEventDeliveryError?.(error, {
            executionId,
            commitId: "pending",
          });
        }
      }
      return {
        recovered,
        pending: (await listCanonicalHandoffFiles(paths)).length,
        failed,
        quarantined: (await listQuarantinedCanonicalHandoffFiles(paths)).length,
      };
    },
    async inspectCanonicalEventDelivery() {
      return {
        pending: (await listCanonicalHandoffFiles(paths)).length,
        quarantined: (await listQuarantinedCanonicalHandoffFiles(paths)).length,
      };
    },
    async delete(executionId) {
      await withExecutionLock(executionId, "delete", async () => {
        await rm(paths.executionRoot(executionId), { recursive: true, force: true });
        await rm(paths.executionArchive(executionId), { force: true });
      });
    },
    async archive(executionId) {
      await withExecutionLock(executionId, "archive", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        const state = await requireExecution(paths, executionId);
        if (!isTerminalExecutionStatus(state.status)) {
          throw new Error(`Cannot archive a non-terminal Execution: ${executionId}.`);
        }
        const source = paths.executionEvents(executionId);
        let contents: Buffer;
        try {
          contents = await readFile(source);
        } catch (error) {
          if (isNotFound(error)) return;
          throw error;
        }
        const target = paths.executionArchive(executionId);
        const temporary = `${target}.${randomUUID()}.tmp`;
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(temporary, await promisify(gzip)(contents), { mode: 0o600 });
        await rename(temporary, target);
        await rm(source, { force: true });
      });
    },
    async create(record, root) {
      void stableStringify({ record, root });
      await withExecutionLock(record.executionId, "create", async () => {
        await prepareExecution(paths, record.executionId, options.canonicalEventFeed);
        if ((await readJsonIfExists(paths.executionState(record.executionId))) !== undefined) {
          throw new Error(`Execution already exists: ${record.executionId}`);
        }
        const parsedRecord = ExecutionRecordSchema.parse(record);
        if (parsedRecord.version !== 0 || parsedRecord.lastAppliedSequence !== 0) {
          throw new Error("A new Execution must start at version 0 and sequence 0.");
        }
        await writeJsonAtomic(paths.executionState(record.executionId), parsedRecord);
        await writeJsonAtomic(paths.executionInvocations(record.executionId), [
          InvocationSchema.parse(root),
        ]);
        await writeJsonAtomic(paths.executionAgents(record.executionId), []);
        await writeJsonAtomic(paths.executionContexts(record.executionId), []);
        await writeJsonAtomic(paths.executionCommits(record.executionId), []);
      });
    },

    async get(executionId) {
      return await withExecutionLock(executionId, "get", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        const value = await readJsonIfExists(paths.executionState(executionId));
        if (value === undefined) return undefined;
        const parsed = ExecutionRecordSchema.safeParse(value);
        if (!parsed.success) throw unsupportedState(executionId, parsed.error);
        return parsed.data;
      });
    },

    async update(executionId, patch) {
      const result = await store.commit({
        commitId: randomUUID(),
        executionId,
        executionPatch: patch,
      });
      return result.execution;
    },

    async commit(request) {
      if (request.commitId.trim() === "") throw new Error("Execution commitId must not be empty.");
      const signature = commitSignature(request);
      return await withExecutionLock(request.executionId, "commit", async () => {
        await prepareExecution(paths, request.executionId, options.canonicalEventFeed);
        const commits = await readCommitRecords(paths, request.executionId);
        const duplicate = commits.find((commit) => commit.commitId === request.commitId);
        if (duplicate !== undefined) {
          if (duplicate.signature !== signature) {
            throw new Error(`Execution commit idempotency conflict: ${request.commitId}`);
          }
          return await readCommitResult(paths, request.executionId, duplicate.eventIds);
        }

        const current = await requireExecution(paths, request.executionId);
        if (request.expectedVersion !== undefined && request.expectedVersion !== current.version) {
          throw new ExecutionVersionConflictError(request.expectedVersion, current.version);
        }

        const now = new Date().toISOString();
        const currentInvocations = await readInvocations(paths, request.executionId);
        const currentAgents = await readAgents(paths, request.executionId);
        const currentContexts = await readContexts(paths, request.executionId);
        assertFinalStatusTransitions(
          current,
          currentInvocations,
          request,
          hasActiveRecoveryClaim(current, request.recoveryClaimId),
        );
        const nextInvocations = applyInvocationChanges(
          currentInvocations,
          request.invocationPuts ?? [],
          request.invocationPatches ?? [],
          now,
        );
        const nextAgents = applyAgentChanges(
          currentAgents,
          request.agentPuts ?? [],
          request.agentPatches ?? [],
          now,
        );
        const nextContexts = applyContextChanges(
          currentContexts,
          request.contextPuts ?? [],
          request.contextPatches ?? [],
          now,
        );
        assertAgentContextBindings(nextAgents, nextContexts, nextInvocations);
        const existingEvents = await readExecutionEvents(paths, request.executionId);
        const materialized = materializeEvents(
          request.executionId,
          existingEvents,
          request.events ?? [],
          now,
        );
        const lastSequence =
          materialized.newEvents.at(-1)?.cursor.sequence ?? current.lastAppliedSequence;
        const nextExecution = ExecutionRecordSchema.parse({
          ...current,
          ...request.executionPatch,
          schemaVersion: "pragma.execution/v10",
          executionId: request.executionId,
          version: current.version + 1,
          lastAppliedSequence: lastSequence,
          updatedAt: now,
        });
        const journal = ExecutionCommitJournalSchema.parse({
          schemaVersion: "pragma.execution-transaction/v11",
          commitId: request.commitId,
          signature,
          execution: nextExecution,
          invocations: nextInvocations,
          agents: nextAgents,
          contexts: nextContexts,
          events: materialized.newEvents,
          eventIds: materialized.requestedEvents.map((event) => event.eventId),
        });
        if (options.canonicalEventFeed !== undefined && materialized.newEvents.length > 0) {
          const handoff = CanonicalEventHandoffSchema.parse({
            schemaVersion: "pragma.canonical-event-handoff/v1",
            executionId: request.executionId,
            commitId: request.commitId,
            signature,
            createdAt: now,
            transaction: journal,
            events: materialized.newEvents.map((event) =>
              toCanonicalExecutionEvent(event, journal),
            ),
          });
          const handoffPath = paths.canonicalEventHandoff(request.executionId, request.commitId);
          await writeJsonAtomic(handoffPath, handoff);
          await applyTransaction(paths, request.executionId, journal);
          try {
            await publishCanonicalHandoff(handoffPath, handoff, options.canonicalEventFeed);
          } catch (error) {
            options.onCanonicalEventDeliveryError?.(error, {
              executionId: request.executionId,
              commitId: request.commitId,
            });
          }
        } else {
          await writeJsonAtomic(paths.executionTransaction(request.executionId), journal);
          await applyTransaction(paths, request.executionId, journal);
        }
        for (const event of materialized.newEvents) {
          getExecutionLiveBus(store).publishEvent(request.executionId, event);
        }
        return {
          execution: nextExecution,
          invocations: nextInvocations,
          agents: nextAgents,
          contexts: nextContexts,
          events: materialized.requestedEvents,
        };
      });
    },

    async claimRecovery(executionId, claimId, leaseMs) {
      return await withExecutionLock(executionId, "claim-recovery", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        const current = await requireExecution(paths, executionId);
        const value = current.state[EXECUTION_RECOVERY_CLAIM_STATE_KEY];
        if (typeof value === "object" && value !== null) {
          const existingClaimId = (value as { claimId?: unknown }).claimId;
          const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
          const processId = (value as { processId?: unknown }).processId;
          if (
            existingClaimId !== claimId &&
            typeof expiresAt === "string" &&
            Date.parse(expiresAt) > Date.now() &&
            (typeof processId !== "number" || isProcessAlive(processId))
          ) {
            return false;
          }
        }
        const updated = ExecutionRecordSchema.parse({
          ...current,
          version: current.version + 1,
          state: {
            ...current.state,
            [EXECUTION_RECOVERY_CLAIM_STATE_KEY]: {
              claimId,
              processId: process.pid,
              expiresAt: new Date(Date.now() + leaseMs).toISOString(),
            },
          },
          updatedAt: new Date().toISOString(),
        });
        await writeJsonAtomic(paths.executionState(executionId), updated);
        return true;
      });
    },

    async getInvocation(executionId, invocationId) {
      return await withExecutionLock(executionId, "get-invocation", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        return (await readInvocations(paths, executionId)).find(
          (invocation) => invocation.invocationId === invocationId,
        );
      });
    },

    async listInvocations(executionId) {
      return await withExecutionLock(executionId, "list-invocations", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        return await readInvocations(paths, executionId);
      });
    },

    async getAgent(executionId, agentId) {
      return await withExecutionLock(executionId, "get-agent", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        return (await readAgents(paths, executionId)).find((agent) => agent.agentId === agentId);
      });
    },

    async listAgents(executionId) {
      return await withExecutionLock(executionId, "list-agents", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        return await readAgents(paths, executionId);
      });
    },

    async getContext(executionId, contextId) {
      return await withExecutionLock(executionId, "get-context", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        return (await readContexts(paths, executionId)).find(
          (context) => context.contextId === contextId,
        );
      });
    },

    async listContexts(executionId) {
      return await withExecutionLock(executionId, "list-contexts", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        return await readContexts(paths, executionId);
      });
    },

    async putInvocation(executionId, invocation) {
      await store.commit({
        commitId: randomUUID(),
        executionId,
        invocationPuts: [invocation],
      });
    },

    async getTree(executionId) {
      return await withExecutionLock(executionId, "get-tree", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        const value = await readJsonIfExists(paths.executionState(executionId));
        if (value === undefined) return undefined;
        const record = ExecutionRecordSchema.parse(value);
        return buildTree(record.rootInvocationId, await readInvocations(paths, executionId));
      });
    },

    async appendEvent(executionId, invocationId, type, data, eventId = randomUUID()) {
      const result = await store.commit({
        commitId: randomUUID(),
        executionId,
        events: [{ eventId, invocationId, type, data }],
      });
      const event = result.events.find((candidate) => candidate.eventId === eventId);
      if (event === undefined) throw new Error(`Execution event was not committed: ${eventId}`);
      return event;
    },

    async readEvents(executionId, after) {
      return await withExecutionLock(executionId, "read-events", async () => {
        await prepareExecution(paths, executionId, options.canonicalEventFeed);
        return filterAfter(await readExecutionEvents(paths, executionId), executionId, after);
      });
    },
  };

  return store;
}

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

function isProcessAlive(processId: number): boolean {
  if (processId === process.pid) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code === "EPERM"
    );
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
): { readonly newEvents: ExecutionEvent[]; readonly requestedEvents: ExecutionEvent[] } {
  const byId = new Map(existingEvents.map((event) => [event.eventId, event]));
  const newEvents: ExecutionEvent[] = [];
  const requestedEvents: ExecutionEvent[] = [];
  let sequence = existingEvents.at(-1)?.cursor.sequence ?? 0;

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

async function recoverTransaction(paths: PragmaPaths, executionId: string): Promise<void> {
  const value = await readJsonIfExists(paths.executionTransaction(executionId));
  if (value === undefined) return;
  let journal: ReturnType<typeof executionCommitJournalMigrationChain.upgrade>;
  try {
    journal = executionCommitJournalMigrationChain.upgrade(value);
  } catch (error) {
    throw unsupportedState(executionId, error);
  }
  if (journal.migrated) {
    await writeJsonAtomic(paths.executionTransaction(executionId), journal.value);
  }
  await applyTransaction(paths, executionId, journal.value);
}

async function prepareExecution(
  paths: PragmaPaths,
  executionId: string,
  canonicalEventFeed?: CanonicalEventFeed,
): Promise<void> {
  try {
    await recoverAtomicStateMigration({
      aggregateRoot: paths.executionRoot(executionId),
      journalFile: paths.executionMigration(executionId),
      resource: { family: "pragma.execution", id: executionId },
      validateDocuments: validateExecutionMigrationDocuments,
    });
    await recoverTransaction(paths, executionId);
    if (canonicalEventFeed !== undefined) {
      await assertNoQuarantinedCanonicalHandoffs(paths, executionId);
      await recoverCanonicalHandoffsForExecution(paths, executionId, canonicalEventFeed);
    }
    await migrateExecutionState(paths, executionId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unsupported-state-version:")) {
      throw error;
    }
    throw unsupportedState(executionId, error);
  }
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

async function recoverCanonicalHandoffsForExecution(
  paths: PragmaPaths,
  executionId: string,
  feed: CanonicalEventFeed,
): Promise<{
  readonly recovered: number;
  readonly deliveryFailure?: {
    readonly error: unknown;
    readonly file: string;
    readonly handoff: CanonicalEventHandoff;
  };
}> {
  await assertNoQuarantinedCanonicalHandoffs(paths, executionId);
  const files = await listCanonicalHandoffFilesForExecution(paths, executionId);
  const handoffs: { readonly file: string; readonly handoff: CanonicalEventHandoff }[] = [];
  for (const file of files) {
    try {
      const handoff = await readCanonicalHandoff(file);
      if (handoff.executionId !== executionId) {
        throw new Error(`Canonical event handoff owner mismatch: ${handoff.executionId}`);
      }
      assertCanonicalHandoffFileOwner(file, handoff.executionId);
      handoffs.push({ file, handoff });
    } catch (error) {
      const quarantinedPath = await quarantineCanonicalHandoff(paths, file);
      throw new Error(
        `unsupported-state-version:pragma.canonical-event-handoff-quarantined:${executionId}:${quarantinedPath}`,
        { cause: error },
      );
    }
  }
  let recovered = 0;
  for (const entry of handoffs.toSorted(
    (left, right) =>
      left.handoff.transaction.execution.version - right.handoff.transaction.execution.version,
  )) {
    const result = await recoverCanonicalHandoffFile(paths, entry.file, entry.handoff, feed);
    if (!result.delivered) {
      return {
        recovered,
        deliveryFailure: { error: result.error, file: entry.file, handoff: entry.handoff },
      };
    }
    recovered += 1;
  }
  return { recovered };
}

async function listCanonicalHandoffFilesForExecution(
  paths: PragmaPaths,
  executionId: string,
): Promise<string[]> {
  const prefix = `${encodePragmaPathSegment(executionId)}.`;
  return (await listCanonicalHandoffFiles(paths)).filter((file) =>
    basename(file).startsWith(prefix),
  );
}

function assertCanonicalHandoffFileOwner(file: string, executionId: string): void {
  const prefix = `${encodePragmaPathSegment(executionId)}.`;
  if (!basename(file).startsWith(prefix)) {
    throw new Error(`Canonical event handoff filename owner mismatch: ${executionId}`);
  }
}

async function listQuarantinedCanonicalHandoffFilesForExecution(
  paths: PragmaPaths,
  executionId: string,
): Promise<string[]> {
  const prefix = `${encodePragmaPathSegment(executionId)}.`;
  return (await listQuarantinedCanonicalHandoffFiles(paths)).filter((file) =>
    basename(file).startsWith(prefix),
  );
}

async function assertNoQuarantinedCanonicalHandoffs(
  paths: PragmaPaths,
  executionId: string,
): Promise<void> {
  const files = await listQuarantinedCanonicalHandoffFilesForExecution(paths, executionId);
  if (files.length === 0) return;
  throw new Error(
    `unsupported-state-version:pragma.canonical-event-handoff-quarantined:${executionId}:${files[0]}`,
  );
}

async function recoverCanonicalHandoffFile(
  paths: PragmaPaths,
  file: string,
  handoff: CanonicalEventHandoff,
  feed: CanonicalEventFeed,
): Promise<{ readonly delivered: true } | { readonly delivered: false; readonly error: unknown }> {
  const commits = await readCommitRecords(paths, handoff.executionId);
  const committed = commits.find((candidate) => candidate.commitId === handoff.commitId);
  if (committed === undefined) {
    await applyTransaction(paths, handoff.executionId, handoff.transaction);
  } else if (committed.signature !== handoff.signature) {
    throw new Error(`Canonical event handoff signature conflict: ${handoff.commitId}`);
  }
  try {
    await publishCanonicalHandoff(file, handoff, feed);
    return { delivered: true };
  } catch (error) {
    // Source durability must not depend on transient delivery availability.
    return { delivered: false, error };
  }
}

async function publishCanonicalHandoff(
  file: string,
  handoff: CanonicalEventHandoff,
  feed: CanonicalEventFeed,
): Promise<void> {
  await feed.append(handoff.events);
  await rm(file, { force: true });
}

async function readCanonicalHandoff(file: string): Promise<CanonicalEventHandoff> {
  return CanonicalEventHandoffSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

async function listCanonicalHandoffFiles(paths: PragmaPaths): Promise<string[]> {
  try {
    return (await readdir(paths.canonicalEventHandoffsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(paths.canonicalEventHandoffsRoot(), entry.name))
      .toSorted();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function listQuarantinedCanonicalHandoffFiles(paths: PragmaPaths): Promise<string[]> {
  try {
    return (await readdir(paths.canonicalEventHandoffQuarantineRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(paths.canonicalEventHandoffQuarantineRoot(), entry.name))
      .toSorted();
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function quarantineCanonicalHandoff(paths: PragmaPaths, file: string): Promise<string> {
  const root = paths.canonicalEventHandoffQuarantineRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, `${basename(file)}.${randomUUID()}.blocked`);
  await rename(file, target);
  return target;
}

async function migrateExecutionState(paths: PragmaPaths, executionId: string): Promise<void> {
  const value = await readJsonIfExists(paths.executionState(executionId));
  if (value === undefined) return;
  const upgraded = executionRecordMigrationChain.upgrade(value);
  if (!upgraded.migrated) return;
  const storedInvocations = (await readJsonIfExists(paths.executionInvocations(executionId))) ?? [];
  const usageMigratedInvocations = Array.isArray(storedInvocations)
    ? storedInvocations.map(migrateInvocationUsageV7ToV8)
    : storedInvocations;
  const handoffMigratedInvocations =
    upgraded.fromVersion === 5
      ? migrateExecutionInvocationsV5ToV6(usageMigratedInvocations)
      : usageMigratedInvocations;
  const invocations =
    upgraded.fromVersion <= 9
      ? migrateExecutionInvocationsV9ToV10(handoffMigratedInvocations)
      : InvocationSchema.array().parse(handoffMigratedInvocations);
  await applyAtomicStateMigration({
    aggregateRoot: paths.executionRoot(executionId),
    journalFile: paths.executionMigration(executionId),
    resource: { family: "pragma.execution", id: executionId },
    fromVersion: upgraded.fromVersion,
    toVersion: upgraded.toVersion,
    documents: {
      "execution.json": upgraded.value,
      "invocations.json": invocations,
    },
    validateDocuments: validateExecutionMigrationDocuments,
  });
}

function validateExecutionMigrationDocuments(documents: Readonly<Record<string, unknown>>): void {
  const keys = Object.keys(documents).toSorted();
  if (keys.length !== 2 || keys[0] !== "execution.json" || keys[1] !== "invocations.json") {
    throw new Error("Execution migration journal contains unexpected documents.");
  }
  ExecutionRecordSchema.parse(documents["execution.json"]);
  InvocationSchema.array().parse(documents["invocations.json"]);
}

async function applyTransaction(
  paths: PragmaPaths,
  executionId: string,
  journal: ExecutionCommitJournal,
): Promise<void> {
  const existingEvents = await readExecutionEvents(paths, executionId);
  const mergedEvents = mergeEvents(existingEvents, journal.events);
  const commits = await readCommitRecords(paths, executionId);
  const existingCommit = commits.find((commit) => commit.commitId === journal.commitId);
  if (existingCommit !== undefined && existingCommit.signature !== journal.signature) {
    throw new Error(`Execution commit idempotency conflict: ${journal.commitId}`);
  }
  const nextCommits =
    existingCommit === undefined
      ? [
          ...commits,
          ExecutionCommitRecordSchema.parse({
            commitId: journal.commitId,
            signature: journal.signature,
            eventIds: journal.eventIds,
            committedVersion: journal.execution.version,
          }),
        ]
      : commits;

  await writeJsonAtomic(paths.executionState(executionId), journal.execution);
  await writeJsonAtomic(paths.executionInvocations(executionId), journal.invocations);
  await writeJsonAtomic(paths.executionAgents(executionId), journal.agents);
  await writeJsonAtomic(paths.executionContexts(executionId), journal.contexts);
  await writeJsonLinesAtomic(paths.executionEvents(executionId), mergedEvents);
  await writeJsonAtomic(paths.executionCommits(executionId), nextCommits);
  await rm(paths.executionTransaction(executionId), { force: true });
}

function mergeEvents(
  existing: readonly ExecutionEvent[],
  added: readonly ExecutionEvent[],
): ExecutionEvent[] {
  const merged = [...existing];
  const byId = new Map(existing.map((event) => [event.eventId, event]));
  for (const event of added) {
    const duplicate = byId.get(event.eventId);
    if (duplicate !== undefined) {
      if (stableStringify(duplicate) !== stableStringify(event)) {
        throw new Error(`Execution event idempotency conflict: ${event.eventId}`);
      }
      continue;
    }
    const expectedSequence = (merged.at(-1)?.cursor.sequence ?? 0) + 1;
    if (event.cursor.sequence !== expectedSequence) {
      throw new Error(
        `Execution event sequence conflict: expected ${expectedSequence}, received ${event.cursor.sequence}.`,
      );
    }
    merged.push(parseExecutionEvent(event));
    byId.set(event.eventId, event);
  }
  return merged;
}

async function readCommitResult(
  paths: PragmaPaths,
  executionId: string,
  eventIds: readonly string[],
): Promise<ExecutionCommitResult> {
  const execution = await requireExecution(paths, executionId);
  const invocations = await readInvocations(paths, executionId);
  const agents = await readAgents(paths, executionId);
  const contexts = await readContexts(paths, executionId);
  const eventById = new Map(
    (await readExecutionEvents(paths, executionId)).map((event) => [event.eventId, event]),
  );
  return {
    execution,
    invocations,
    agents,
    contexts,
    events: eventIds.map((eventId) => {
      const event = eventById.get(eventId);
      if (event === undefined) throw new Error(`Committed Execution event is missing: ${eventId}`);
      return event;
    }),
  };
}

async function requireExecution(paths: PragmaPaths, executionId: string): Promise<ExecutionRecord> {
  const value = await readJsonIfExists(paths.executionState(executionId));
  if (value === undefined) throw new Error(`Execution not found: ${executionId}`);
  const parsed = ExecutionRecordSchema.safeParse(value);
  if (!parsed.success) throw unsupportedState(executionId, parsed.error);
  return parsed.data;
}

async function readInvocations(paths: PragmaPaths, executionId: string): Promise<Invocation[]> {
  const value = await readJsonIfExists(paths.executionInvocations(executionId));
  if (value === undefined) return [];
  return InvocationSchema.array().parse(value);
}

async function readAgents(paths: PragmaPaths, executionId: string): Promise<AgentInstance[]> {
  const value = await readJsonIfExists(paths.executionAgents(executionId));
  if (value === undefined) return [];
  return AgentInstanceSchema.array().parse(value);
}

async function readContexts(
  paths: PragmaPaths,
  executionId: string,
): Promise<RuntimeContextRecord[]> {
  const value = await readJsonIfExists(paths.executionContexts(executionId));
  if (value === undefined) return [];
  return RuntimeContextRecordSchema.array().parse(value);
}

async function readExecutionEvents(
  paths: PragmaPaths,
  executionId: string,
): Promise<ExecutionEvent[]> {
  const [hasActive, hasArchive] = await Promise.all([
    stat(paths.executionEvents(executionId)).then(
      () => true,
      (error: unknown) => (isNotFound(error) ? false : Promise.reject(error)),
    ),
    stat(paths.executionArchive(executionId)).then(
      () => true,
      (error: unknown) => (isNotFound(error) ? false : Promise.reject(error)),
    ),
  ]);
  if (!hasActive && !hasArchive) {
    const execution = await readJsonIfExists(paths.executionState(executionId));
    const parsed = ExecutionRecordSchema.safeParse(execution);
    if (parsed.success && isTerminalExecutionStatus(parsed.data.status)) {
      throw new ExecutionHistoryUnavailableError(executionId);
    }
  }
  const archived = await readArchivedExecutionEvents(paths, executionId);
  const active = await readJsonLines(paths.executionEvents(executionId), {
    parse: parseExecutionEvent,
  });
  if (archived.length === 0) return active;
  const byId = new Map(archived.map((event) => [event.eventId, event] as const));
  for (const event of active) byId.set(event.eventId, event);
  return [...byId.values()].toSorted((left, right) => left.cursor.sequence - right.cursor.sequence);
}

async function readArchivedExecutionEvents(
  paths: PragmaPaths,
  executionId: string,
): Promise<ExecutionEvent[]> {
  try {
    const contents = await promisify(gunzip)(await readFile(paths.executionArchive(executionId)));
    return contents
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => parseExecutionEvent(JSON.parse(line) as unknown));
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readCommitRecords(
  paths: PragmaPaths,
  executionId: string,
): Promise<ExecutionCommitRecord[]> {
  const value = await readJsonIfExists(paths.executionCommits(executionId));
  if (value === undefined) return [];
  return ExecutionCommitRecordSchema.array().parse(value);
}

function parseExecutionEvent(value: unknown): ExecutionEvent {
  return ExecutionEventSchema.parse(value);
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonLinesAtomic(file: string, values: readonly unknown[]): Promise<void> {
  const content =
    values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
  await writeTextAtomic(file, content);
}

async function writeTextAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await renameWithRetry(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJsonLines<T>(file: string, schema: { parse(value: unknown): T }): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return content
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => schema.parse(JSON.parse(line) as unknown));
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

function unsupportedState(executionId: string, cause: unknown): Error {
  return new Error(`unsupported-state-version: Execution ${executionId}`, { cause });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 20 || !isRetryableRename(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
}

function isRetryableRename(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES")
  );
}
