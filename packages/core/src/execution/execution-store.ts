import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ExecutionEventSchema,
  ExecutionRecordSchema,
  InvocationSchema,
  type ExecutionCursor,
  type ExecutionEvent,
  type ExecutionRecord,
  type Invocation,
  type InvocationTree,
} from "@pragma/shared";
import { z } from "zod";

import { withFileLock } from "../storage/file-lock.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";
import { getExecutionLiveBus } from "./execution-live-bus.ts";

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

export interface ExecutionCommitRequest {
  readonly commitId: string;
  readonly executionId: string;
  readonly expectedVersion?: number | undefined;
  readonly executionPatch?: Partial<ExecutionRecord> | undefined;
  readonly invocationPuts?: readonly Invocation[] | undefined;
  readonly invocationPatches?: readonly ExecutionInvocationPatch[] | undefined;
  readonly events?: readonly NewExecutionEvent[] | undefined;
}

export interface ExecutionCommitResult {
  readonly execution: ExecutionRecord;
  readonly invocations: readonly Invocation[];
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

export interface ExecutionStore {
  create(record: ExecutionRecord, root: Invocation): Promise<void>;
  get(executionId: string): Promise<ExecutionRecord | undefined>;
  update(executionId: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord>;
  commit(request: ExecutionCommitRequest): Promise<ExecutionCommitResult>;
  claimRecovery(executionId: string, claimId: string, leaseMs: number): Promise<boolean>;
  getInvocation(executionId: string, invocationId: string): Promise<Invocation | undefined>;
  listInvocations(executionId: string): Promise<readonly Invocation[]>;
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
}

const ExecutionCommitRecordSchema = z.object({
  commitId: z.string().min(1),
  signature: z.string().length(64),
  eventIds: z.array(z.string().min(1)),
  committedVersion: z.number().int().nonnegative(),
});

const ExecutionCommitJournalSchema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v3"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordSchema,
  invocations: InvocationSchema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

type ExecutionCommitRecord = z.infer<typeof ExecutionCommitRecordSchema>;
type ExecutionCommitJournal = z.infer<typeof ExecutionCommitJournalSchema>;

export function createFileExecutionStore(
  options: { readonly pragmaHome?: string } = {},
): ExecutionStore {
  const paths = new PragmaPaths(options);

  const store: ExecutionStore = {
    async create(record, root) {
      void stableStringify({ record, root });
      await withFileLock(paths.executionLock(record.executionId), async () => {
        await recoverTransaction(paths, record.executionId);
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
        await writeJsonAtomic(paths.executionCommits(record.executionId), []);
      });
    },

    async get(executionId) {
      return await withFileLock(paths.executionLock(executionId), async () => {
        await recoverTransaction(paths, executionId);
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
      return await withFileLock(paths.executionLock(request.executionId), async () => {
        await recoverTransaction(paths, request.executionId);
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
        assertFinalStatusTransitions(current, currentInvocations, request);
        const nextInvocations = applyInvocationChanges(
          currentInvocations,
          request.invocationPuts ?? [],
          request.invocationPatches ?? [],
          now,
        );
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
          schemaVersion: "pragma.execution/v3",
          executionId: request.executionId,
          version: current.version + 1,
          lastAppliedSequence: lastSequence,
          updatedAt: now,
        });
        const journal = ExecutionCommitJournalSchema.parse({
          schemaVersion: "pragma.execution-transaction/v3",
          commitId: request.commitId,
          signature,
          execution: nextExecution,
          invocations: nextInvocations,
          events: materialized.newEvents,
          eventIds: materialized.requestedEvents.map((event) => event.eventId),
        });
        await writeJsonAtomic(paths.executionTransaction(request.executionId), journal);
        await applyTransaction(paths, request.executionId, journal);
        for (const event of materialized.newEvents) {
          getExecutionLiveBus(store).publishEvent(request.executionId, event);
        }
        return {
          execution: nextExecution,
          invocations: nextInvocations,
          events: materialized.requestedEvents,
        };
      });
    },

    async claimRecovery(executionId, claimId, leaseMs) {
      return await withFileLock(paths.executionLock(executionId), async () => {
        await recoverTransaction(paths, executionId);
        const current = await requireExecution(paths, executionId);
        const value = current.state["__recoveryClaim"];
        if (typeof value === "object" && value !== null) {
          const existingClaimId = (value as { claimId?: unknown }).claimId;
          const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
          if (
            existingClaimId !== claimId &&
            typeof expiresAt === "string" &&
            Date.parse(expiresAt) > Date.now()
          ) {
            return false;
          }
        }
        const updated = ExecutionRecordSchema.parse({
          ...current,
          version: current.version + 1,
          state: {
            ...current.state,
            __recoveryClaim: {
              claimId,
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
      return await withFileLock(paths.executionLock(executionId), async () => {
        await recoverTransaction(paths, executionId);
        return (await readInvocations(paths, executionId)).find(
          (invocation) => invocation.invocationId === invocationId,
        );
      });
    },

    async listInvocations(executionId) {
      return await withFileLock(paths.executionLock(executionId), async () => {
        await recoverTransaction(paths, executionId);
        return await readInvocations(paths, executionId);
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
      return await withFileLock(paths.executionLock(executionId), async () => {
        await recoverTransaction(paths, executionId);
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
      return await withFileLock(paths.executionLock(executionId), async () => {
        await recoverTransaction(paths, executionId);
        return filterAfter(await readExecutionEvents(paths, executionId), executionId, after);
      });
    },
  };

  return store;
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
    byId.set(
      change.invocationId,
      InvocationSchema.parse({
        ...invocation,
        ...change.patch,
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
): void {
  assertFinalStatusTransition(
    `Execution ${execution.executionId}`,
    execution.status,
    request.executionPatch?.status,
  );
  const byId = new Map(invocations.map((invocation) => [invocation.invocationId, invocation]));
  for (const invocation of request.invocationPuts ?? []) {
    const current = byId.get(invocation.invocationId);
    if (current !== undefined) {
      assertFinalStatusTransition(
        `Invocation ${invocation.invocationId}`,
        current.status,
        invocation.status,
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
      );
    }
  }
}

function assertFinalStatusTransition(
  subject: string,
  current: Invocation["status"],
  requested: Invocation["status"] | undefined,
): void {
  if (requested !== undefined && isFinalStatus(current) && requested !== current) {
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
      schemaVersion: "pragma.execution-event/v3",
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
  const journal = ExecutionCommitJournalSchema.safeParse(value);
  if (!journal.success) throw unsupportedState(executionId, journal.error);
  await applyTransaction(paths, executionId, journal.data);
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
  const eventById = new Map(
    (await readExecutionEvents(paths, executionId)).map((event) => [event.eventId, event]),
  );
  return {
    execution,
    invocations,
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

async function readExecutionEvents(
  paths: PragmaPaths,
  executionId: string,
): Promise<ExecutionEvent[]> {
  return await readJsonLines(paths.executionEvents(executionId), { parse: parseExecutionEvent });
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

function isFinalStatus(status: string | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function buildTree(rootId: string, invocations: readonly Invocation[]): InvocationTree {
  const byId = new Map(invocations.map((invocation) => [invocation.invocationId, invocation]));
  const root = byId.get(rootId);
  if (root === undefined) throw new Error(`Root Invocation not found: ${rootId}`);
  const visit = (invocation: Invocation): InvocationTree => ({
    invocation,
    children: invocations
      .filter((candidate) => candidate.parentInvocationId === invocation.invocationId)
      .map(visit),
  });
  return visit(root);
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
