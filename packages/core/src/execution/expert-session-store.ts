import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ExecutionRecordSchema,
  ExpertSessionRecordSchema,
  InvocationSchema,
  PromptRequestSchema,
  type ExecutionRecord,
  type ExpertSessionRecord,
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
}

export function createFileExpertSessionStore(options: {
  readonly executions: ExecutionStore;
  readonly pragmaHome?: string;
}): ExpertSessionStore {
  const paths = new PragmaPaths(options);
  return {
    async create(record) {
      await withFileLock(paths.expertSessionLock(record.sessionId), async () => {
        if ((await readJson(paths.expertSessionState(record.sessionId))) !== undefined) {
          throw new Error(`ExpertSession already exists: ${record.sessionId}`);
        }
        await writeJson(paths.expertSessionState(record.sessionId), record);
        await writeJson(paths.expertSessionPrompts(record.sessionId), []);
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
        const journal = EnqueueJournalSchema.parse({
          schemaVersion: "pragma.expert-session-transaction/v1",
          session: nextSession,
          prompts: nextPrompts,
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
        const next = await action({ session: session.data, prompts });
        await writeJson(
          paths.expertSessionState(sessionId),
          ExpertSessionRecordSchema.parse(next.session),
        );
        await writeJson(
          paths.expertSessionPrompts(sessionId),
          PromptRequestSchema.array().parse(next.prompts),
        );
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
  };
}

const EnqueueJournalSchema = z.object({
  schemaVersion: z.literal("pragma.expert-session-transaction/v1"),
  session: ExpertSessionRecordSchema,
  prompts: PromptRequestSchema.array(),
  execution: ExecutionRecordSchema,
  rootInvocation: InvocationSchema,
});

type EnqueueJournal = z.infer<typeof EnqueueJournalSchema>;

async function recoverTransaction(
  paths: PragmaPaths,
  executions: ExecutionStore,
  sessionId: string,
): Promise<void> {
  const value = await readJson(paths.expertSessionTransaction(sessionId));
  if (value === undefined) return;
  const journal = EnqueueJournalSchema.safeParse(value);
  if (!journal.success) throw unsupported(sessionId, journal.error);
  await applyTransaction(paths, executions, sessionId, journal.data);
}

async function applyTransaction(
  paths: PragmaPaths,
  executions: ExecutionStore,
  sessionId: string,
  journal: EnqueueJournal,
): Promise<void> {
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
  await writeJson(paths.expertSessionPrompts(sessionId), journal.prompts);
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
