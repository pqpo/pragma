import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ExecutionEventSchema,
  ExecutionOutputEventSchema,
  ExecutionRecordSchema,
  InvocationSchema,
  type ExecutionCursor,
  type ExecutionEvent,
  type ExecutionOutputEvent,
  type ExecutionRecord,
  type Invocation,
  type InvocationTree,
} from "@pragma/shared";

import { withFileLock } from "../storage/file-lock.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";

export interface ExecutionStore {
  create(record: ExecutionRecord, root: Invocation): Promise<void>;
  get(executionId: string): Promise<ExecutionRecord | undefined>;
  update(executionId: string, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord>;
  claimRecovery(executionId: string, claimId: string, leaseMs: number): Promise<boolean>;
  getInvocation(executionId: string, invocationId: string): Promise<Invocation | undefined>;
  listInvocations(executionId: string): Promise<readonly Invocation[]>;
  putInvocation(executionId: string, invocation: Invocation): Promise<void>;
  getTree(executionId: string): Promise<InvocationTree | undefined>;
  appendEvent(
    executionId: string,
    invocationId: string,
    type: string,
    payload: unknown,
    eventId?: string,
  ): Promise<ExecutionEvent>;
  appendOutput(
    executionId: string,
    invocationId: string,
    output: Omit<
      ExecutionOutputEvent,
      "eventId" | "cursor" | "executionId" | "invocationId" | "occurredAt"
    >,
    eventId?: string,
  ): Promise<ExecutionOutputEvent>;
  readEvents(executionId: string, after?: ExecutionCursor): Promise<readonly ExecutionEvent[]>;
  readOutputs(
    executionId: string,
    after?: ExecutionCursor,
  ): Promise<readonly ExecutionOutputEvent[]>;
  watchEvents(executionId: string, after?: ExecutionCursor): AsyncIterable<ExecutionEvent>;
  watchOutputs(executionId: string, after?: ExecutionCursor): AsyncIterable<ExecutionOutputEvent>;
}

export function createFileExecutionStore(
  options: { readonly pragmaHome?: string } = {},
): ExecutionStore {
  const paths = new PragmaPaths(options);

  return {
    async create(record, root) {
      await withFileLock(paths.executionLock(record.executionId), async () => {
        if ((await readJsonIfExists(paths.executionState(record.executionId))) !== undefined) {
          throw new Error(`Execution already exists: ${record.executionId}`);
        }
        await writeJsonAtomic(paths.executionState(record.executionId), record);
        await writeJsonAtomic(paths.executionInvocations(record.executionId), [root]);
      });
    },
    async get(executionId) {
      const value = await readJsonIfExists(paths.executionState(executionId));
      if (value === undefined) return undefined;
      const parsed = ExecutionRecordSchema.safeParse(value);
      if (!parsed.success) throw unsupportedState(executionId, parsed.error);
      return parsed.data;
    },
    async update(executionId, patch) {
      return await withFileLock(paths.executionLock(executionId), async () => {
        const current = await requireExecution(paths, executionId);
        const updated = ExecutionRecordSchema.parse({
          ...current,
          ...patch,
          executionId,
          updatedAt: new Date().toISOString(),
        });
        await writeJsonAtomic(paths.executionState(executionId), updated);
        return updated;
      });
    },
    async claimRecovery(executionId, claimId, leaseMs) {
      return await withFileLock(paths.executionLock(executionId), async () => {
        const current = await requireExecution(paths, executionId);
        const value = current.state["__recoveryClaim"];
        if (typeof value === "object" && value !== null) {
          const existingClaimId = (value as { claimId?: unknown }).claimId;
          const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
          if (
            existingClaimId !== claimId &&
            typeof expiresAt === "string" &&
            Date.parse(expiresAt) > Date.now()
          )
            return false;
        }
        const updated = ExecutionRecordSchema.parse({
          ...current,
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
      return (await readInvocations(paths, executionId)).find(
        (invocation) => invocation.invocationId === invocationId,
      );
    },
    async listInvocations(executionId) {
      return await readInvocations(paths, executionId);
    },
    async putInvocation(executionId, invocation) {
      await withFileLock(paths.executionLock(executionId), async () => {
        const invocations = [...(await readInvocations(paths, executionId))];
        const index = invocations.findIndex(
          (candidate) => candidate.invocationId === invocation.invocationId,
        );
        if (index < 0) invocations.push(InvocationSchema.parse(invocation));
        else invocations[index] = InvocationSchema.parse(invocation);
        await writeJsonAtomic(paths.executionInvocations(executionId), invocations);
      });
    },
    async getTree(executionId) {
      const record = await this.get(executionId);
      if (record === undefined) return undefined;
      const invocations = await readInvocations(paths, executionId);
      return buildTree(record.rootInvocationId, invocations);
    },
    async appendEvent(executionId, invocationId, type, payload, eventId = randomUUID()) {
      const event = await appendSequenced(
        paths,
        executionId,
        paths.executionEvents(executionId),
        eventId,
        (sequence) =>
          ExecutionEventSchema.parse({
            eventId,
            cursor: { executionId, sequence },
            executionId,
            invocationId,
            type,
            payload,
            occurredAt: new Date().toISOString(),
          }),
      );
      await this.update(executionId, { lastAppliedSequence: event.cursor.sequence });
      return event;
    },
    async appendOutput(executionId, invocationId, output, eventId = randomUUID()) {
      const event = await appendSequenced(
        paths,
        executionId,
        paths.executionOutputs(executionId),
        eventId,
        (sequence) =>
          ExecutionOutputEventSchema.parse({
            ...output,
            eventId,
            cursor: { executionId, sequence },
            executionId,
            invocationId,
            occurredAt: new Date().toISOString(),
          }),
      );
      return event;
    },
    async readEvents(executionId, after) {
      return await withFileLock(paths.executionLock(executionId), async () =>
        filterAfter(
          await readJsonLines(paths.executionEvents(executionId), ExecutionEventSchema),
          executionId,
          after,
        ),
      );
    },
    async readOutputs(executionId, after) {
      return await withFileLock(paths.executionLock(executionId), async () =>
        filterAfter(
          await readJsonLines(paths.executionOutputs(executionId), ExecutionOutputEventSchema),
          executionId,
          after,
        ),
      );
    },
    watchEvents(executionId, after) {
      return createWatch(
        executionId,
        after,
        (cursor) => this.readEvents(executionId, cursor),
        async () => isTerminal((await this.get(executionId))?.status),
      );
    },
    watchOutputs(executionId, after) {
      return createWatch(
        executionId,
        after,
        (cursor) => this.readOutputs(executionId, cursor),
        async () => isTerminal((await this.get(executionId))?.status),
      );
    },
  };
}

async function appendSequenced<
  T extends { readonly eventId: string; readonly cursor: ExecutionCursor },
>(
  paths: PragmaPaths,
  executionId: string,
  file: string,
  eventId: string,
  create: (sequence: number) => T,
): Promise<T> {
  return await withFileLock(paths.executionLock(executionId), async () => {
    await requireExecution(paths, executionId);
    const existing = await readJsonLines(file, { parse: (value: unknown) => value as T });
    const duplicate = existing.find((event) => event.eventId === eventId);
    if (duplicate !== undefined) return duplicate;
    const sequence = (existing.at(-1)?.cursor.sequence ?? 0) + 1;
    const event = create(sequence);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  });
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

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function createWatch<T extends { readonly cursor: ExecutionCursor }>(
  executionId: string,
  after: ExecutionCursor | undefined,
  readAfter: (cursor: ExecutionCursor | undefined) => Promise<readonly T[]>,
  isComplete: () => Promise<boolean>,
): AsyncIterable<T> {
  return (async function* () {
    let lastSequence = after?.sequence ?? 0;
    while (true) {
      const cursor = { executionId, sequence: lastSequence };
      for (const event of await readAfter(cursor)) {
        if (event.cursor.sequence > lastSequence) {
          lastSequence = event.cursor.sequence;
          yield event;
        }
      }
      if (await isComplete()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  })();
}

function isTerminal(status: string | undefined): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
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
