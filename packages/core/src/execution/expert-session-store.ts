import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ExecutionRecordSchema,
  ExpertSessionEventSchema,
  ExpertSessionRecordSchema,
  InvocationSchema,
  PromptRequestSchema,
  type ExecutionRecord,
  type ExpertSessionRecord,
  type ExpertSessionEvent,
  type Invocation,
  type PromptRequest,
} from "@pragma/shared";
import { z } from "zod";

import { withFileLock } from "../storage/file-lock.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";
import type { ExecutionStore } from "./execution-store.ts";

export interface EnqueuePromptTransaction {
  readonly execution: ExecutionRecord;
  readonly rootInvocation: Invocation;
  readonly prompt: PromptRequest;
}

export interface ExpertSessionStore {
  create(record: ExpertSessionRecord): Promise<void>;
  enqueue(transaction: EnqueuePromptTransaction): Promise<string>;
  get(sessionId: string): Promise<ExpertSessionRecord | undefined>;
  transact<T>(
    sessionId: string,
    action: (state: {
      readonly session: ExpertSessionRecord;
      readonly prompts: readonly PromptRequest[];
    }) =>
      | Promise<{
          readonly result: T;
          readonly session: ExpertSessionRecord;
          readonly prompts: readonly PromptRequest[];
        }>
      | {
          readonly result: T;
          readonly session: ExpertSessionRecord;
          readonly prompts: readonly PromptRequest[];
        },
  ): Promise<T>;
  listPrompts(sessionId: string): Promise<readonly PromptRequest[]>;
  listEvents(sessionId: string): Promise<readonly ExpertSessionEvent[]>;
  claimLease(sessionId: string, claimId: string, leaseMs: number): Promise<boolean>;
  releaseLease(sessionId: string, claimId: string): Promise<void>;
}

export function createFileExpertSessionStore(options: {
  readonly executions: ExecutionStore;
  readonly pragmaHome?: string;
}): ExpertSessionStore {
  const paths = new PragmaPaths(options);
  return {
    async create(record) {
      await withFileLock(paths.expertSessionLock(record.sessionId), async () => {
        await recoverTransaction(paths, options.executions, record.sessionId);
        if ((await readJson(paths.expertSessionState(record.sessionId))) !== undefined) {
          throw new Error(`ExpertSession already exists: ${record.sessionId}`);
        }
        const journal = ExpertSessionTransactionJournalSchema.parse({
          schemaVersion: "pragma.expert-session-transaction/v2",
          session: record,
          prompts: [],
          events: [
            createSessionEvent(
              record.sessionId,
              1,
              "session-created",
              "session.created",
              {},
              record.createdAt,
            ),
          ],
        });
        await writeJson(paths.expertSessionTransaction(record.sessionId), journal);
        await applyTransaction(paths, options.executions, record.sessionId, journal);
      });
    },
    async enqueue(transaction) {
      const sessionId = transaction.prompt.sessionId;
      return await withFileLock(paths.expertSessionLock(sessionId), async () => {
        await recoverTransaction(paths, options.executions, sessionId);
        const session = ExpertSessionRecordSchema.parse(
          await requireJson(paths.expertSessionState(sessionId), sessionId),
        );
        const prompts = PromptRequestSchema.array().parse(
          (await readJson(paths.expertSessionPrompts(sessionId))) ?? [],
        );
        const events = ExpertSessionEventSchema.array().parse(
          (await readJson(paths.expertSessionEvents(sessionId))) ?? [],
        );
        if (session.status === "closed") throw new Error(`ExpertSession is closed: ${sessionId}`);
        const duplicate = prompts.find(
          (candidate) => candidate.requestId === transaction.prompt.requestId,
        );
        if (duplicate !== undefined) {
          if (
            duplicate.content !== transaction.prompt.content ||
            duplicate.mode !== transaction.prompt.mode
          ) {
            throw new Error(`Prompt idempotency conflict: ${transaction.prompt.requestId}`);
          }
          return duplicate.executionId;
        }
        const nextSession = ExpertSessionRecordSchema.parse({
          ...session,
          queuedRequestIds: [...session.queuedRequestIds, transaction.prompt.requestId],
          executionIds: [...session.executionIds, transaction.execution.executionId],
          updatedAt: transaction.prompt.createdAt,
        });
        const nextPrompts = PromptRequestSchema.array().parse([...prompts, transaction.prompt]);
        const journal = ExpertSessionTransactionJournalSchema.parse({
          schemaVersion: "pragma.expert-session-transaction/v2",
          session: nextSession,
          prompts: nextPrompts,
          events: materializeSessionEvents(sessionId, events, [
            {
              eventId: `prompt-enqueued:${transaction.prompt.requestId}`,
              type: "prompt.enqueued",
              data: {
                requestId: transaction.prompt.requestId,
                executionId: transaction.prompt.executionId,
                content: transaction.prompt.content,
              },
              occurredAt: transaction.prompt.createdAt,
            },
          ]),
          execution: transaction.execution,
          rootInvocation: transaction.rootInvocation,
        });
        await writeJson(paths.expertSessionTransaction(sessionId), journal);
        await applyTransaction(paths, options.executions, sessionId, journal);
        return transaction.execution.executionId;
      });
    },
    async get(sessionId) {
      return await withFileLock(paths.expertSessionLock(sessionId), async () => {
        await recoverTransaction(paths, options.executions, sessionId);
        const value = await readJson(paths.expertSessionState(sessionId));
        if (value === undefined) return undefined;
        const parsed = ExpertSessionRecordSchema.safeParse(value);
        if (!parsed.success) throw unsupported(sessionId, parsed.error);
        return parsed.data;
      });
    },
    async transact(sessionId, action) {
      return await withFileLock(paths.expertSessionLock(sessionId), async () => {
        await recoverTransaction(paths, options.executions, sessionId);
        const sessionValue = await readJson(paths.expertSessionState(sessionId));
        if (sessionValue === undefined) throw new Error(`ExpertSession not found: ${sessionId}`);
        const session = ExpertSessionRecordSchema.safeParse(sessionValue);
        if (!session.success) throw unsupported(sessionId, session.error);
        const prompts = PromptRequestSchema.array().parse(
          (await readJson(paths.expertSessionPrompts(sessionId))) ?? [],
        );
        const events = ExpertSessionEventSchema.array().parse(
          (await readJson(paths.expertSessionEvents(sessionId))) ?? [],
        );
        const next = await action({ session: session.data, prompts });
        const journal = ExpertSessionTransactionJournalSchema.parse({
          schemaVersion: "pragma.expert-session-transaction/v2",
          session: next.session,
          prompts: next.prompts,
          events: materializeSessionEvents(
            sessionId,
            events,
            deriveSessionEvents(session.data, prompts, next.session, next.prompts),
          ),
        });
        await writeJson(paths.expertSessionTransaction(sessionId), journal);
        await applyTransaction(paths, options.executions, sessionId, journal);
        return next.result;
      });
    },
    async listPrompts(sessionId) {
      return await withFileLock(paths.expertSessionLock(sessionId), async () => {
        await recoverTransaction(paths, options.executions, sessionId);
        return PromptRequestSchema.array().parse(
          (await readJson(paths.expertSessionPrompts(sessionId))) ?? [],
        );
      });
    },
    async listEvents(sessionId) {
      return await withFileLock(paths.expertSessionLock(sessionId), async () => {
        await recoverTransaction(paths, options.executions, sessionId);
        return ExpertSessionEventSchema.array().parse(
          (await readJson(paths.expertSessionEvents(sessionId))) ?? [],
        );
      });
    },
    async claimLease(sessionId, claimId, leaseMs) {
      return await withFileLock(paths.expertSessionLock(sessionId), async () => {
        const session = ExpertSessionRecordSchema.parse(
          await requireJson(paths.expertSessionState(sessionId), sessionId),
        );
        if (session.status === "closed") return false;
        const existingValue = await readJson(paths.expertSessionLease(sessionId));
        const existing =
          existingValue === undefined ? undefined : ExpertSessionLeaseSchema.parse(existingValue);
        if (
          existing !== undefined &&
          existing.claimId !== claimId &&
          Date.parse(existing.expiresAt) > Date.now()
        ) {
          return false;
        }
        await writeJson(paths.expertSessionLease(sessionId), {
          claimId,
          expiresAt: new Date(Date.now() + leaseMs).toISOString(),
        });
        return true;
      });
    },
    async releaseLease(sessionId, claimId) {
      await withFileLock(paths.expertSessionLock(sessionId), async () => {
        const existingValue = await readJson(paths.expertSessionLease(sessionId));
        const existing =
          existingValue === undefined ? undefined : ExpertSessionLeaseSchema.parse(existingValue);
        if (existing?.claimId === claimId) {
          await rm(paths.expertSessionLease(sessionId), { force: true });
        }
      });
    },
  };
}

const ExpertSessionLeaseSchema = z.object({
  claimId: z.string().min(1),
  expiresAt: z.string().datetime(),
});

const ExpertSessionTransactionJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session-transaction/v2"),
    session: ExpertSessionRecordSchema,
    prompts: PromptRequestSchema.array(),
    events: ExpertSessionEventSchema.array(),
    execution: ExecutionRecordSchema.optional(),
    rootInvocation: InvocationSchema.optional(),
  })
  .refine(
    (journal) => (journal.execution === undefined) === (journal.rootInvocation === undefined),
    "ExpertSession transaction execution and rootInvocation must be provided together.",
  );

type ExpertSessionTransactionJournal = z.infer<typeof ExpertSessionTransactionJournalSchema>;

interface NewSessionEvent {
  readonly eventId: string;
  readonly type: string;
  readonly data: unknown;
  readonly occurredAt: string;
}

function deriveSessionEvents(
  current: ExpertSessionRecord,
  currentPrompts: readonly PromptRequest[],
  next: ExpertSessionRecord,
  nextPrompts: readonly PromptRequest[],
): readonly NewSessionEvent[] {
  const events: NewSessionEvent[] = [];
  const currentPromptIds = new Set(currentPrompts.map((prompt) => prompt.requestId));
  for (const prompt of nextPrompts) {
    if (currentPromptIds.has(prompt.requestId)) continue;
    events.push({
      eventId: `prompt-${prompt.mode}:${prompt.requestId}`,
      type: prompt.mode === "steer" ? "prompt.steered" : "prompt.enqueued",
      data: {
        requestId: prompt.requestId,
        executionId: prompt.executionId,
        content: prompt.content,
      },
      occurredAt: prompt.createdAt,
    });
  }
  if (current.activeExecutionId !== next.activeExecutionId) {
    if (next.activeExecutionId !== undefined) {
      events.push({
        eventId: `execution-attached:${next.activeExecutionId}`,
        type: "execution.attached",
        data: { executionId: next.activeExecutionId },
        occurredAt: next.updatedAt,
      });
    } else if (current.activeExecutionId !== undefined) {
      events.push({
        eventId: `execution-detached:${current.activeExecutionId}`,
        type: "execution.detached",
        data: { executionId: current.activeExecutionId, status: next.lastStatus },
        occurredAt: next.updatedAt,
      });
    }
  }
  if (current.status !== next.status && next.status === "closed") {
    events.push({
      eventId: "session-closed",
      type: "session.closed",
      data: {},
      occurredAt: next.updatedAt,
    });
  }
  return events;
}

function materializeSessionEvents(
  sessionId: string,
  existing: readonly ExpertSessionEvent[],
  inputs: readonly NewSessionEvent[],
): readonly ExpertSessionEvent[] {
  if (inputs.length === 0) return existing;
  const byId = new Set(existing.map((event) => event.eventId));
  const appended = inputs
    .filter((event) => !byId.has(event.eventId))
    .map((event, index) =>
      createSessionEvent(
        sessionId,
        existing.length + index + 1,
        event.eventId,
        event.type,
        event.data,
        event.occurredAt,
      ),
    );
  return [...existing, ...appended];
}

function createSessionEvent(
  sessionId: string,
  sequence: number,
  eventId: string,
  type: string,
  data: unknown,
  occurredAt: string,
): ExpertSessionEvent {
  return ExpertSessionEventSchema.parse({
    schemaVersion: "pragma.expert-session-event/v1",
    eventId,
    cursor: { sessionId, sequence },
    sessionId,
    type,
    data,
    occurredAt,
  });
}

async function recoverTransaction(
  paths: PragmaPaths,
  executions: ExecutionStore,
  sessionId: string,
): Promise<void> {
  const value = await readJson(paths.expertSessionTransaction(sessionId));
  if (value === undefined) return;
  const journal = ExpertSessionTransactionJournalSchema.safeParse(value);
  if (!journal.success) throw unsupported(sessionId, journal.error);
  await applyTransaction(paths, executions, sessionId, journal.data);
}

async function applyTransaction(
  paths: PragmaPaths,
  executions: ExecutionStore,
  sessionId: string,
  journal: ExpertSessionTransactionJournal,
): Promise<void> {
  if (journal.execution !== undefined && journal.rootInvocation !== undefined) {
    const existing = await executions.get(journal.execution.executionId);
    if (existing === undefined) {
      await executions.create(journal.execution, journal.rootInvocation);
    } else if (
      existing.kind !== journal.execution.kind ||
      existing.rootInvocationId !== journal.execution.rootInvocationId ||
      existing.definition.id !== journal.execution.definition.id ||
      existing.definition.version !== journal.execution.definition.version
    ) {
      throw new Error(`Execution conflict while recovering ExpertSession ${sessionId}.`);
    }
  }
  await writeJson(paths.expertSessionPrompts(sessionId), journal.prompts);
  await writeJson(paths.expertSessionEvents(sessionId), journal.events);
  await writeJson(paths.expertSessionState(sessionId), journal.session);
  await rm(paths.expertSessionTransaction(sessionId), { force: true });
}

async function requireJson(file: string, sessionId: string): Promise<unknown> {
  const value = await readJson(file);
  if (value === undefined) throw new Error(`ExpertSession not found: ${sessionId}`);
  return value;
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await renameWithRetry(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function unsupported(sessionId: string, cause: unknown): Error {
  return new Error(`unsupported-state-version: ExpertSession ${sessionId}`, { cause });
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
