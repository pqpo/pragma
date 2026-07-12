import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  errorMemory,
  normalizeTaskRecord,
  okMemory,
  parseTaskMemoryRecord,
  parseTaskMemoryRecords,
  type TaskMemoryRecord,
  type TaskMemoryStore,
} from "../memory-system/index.ts";
import {
  readJsonFile,
  resolveMemoryDirectory,
  resolveMemoryFilePath,
  sanitizeMemoryPathSegment,
  writeJsonFile,
} from "../storage.ts";
import { sameRuntimeSession } from "../memory-system/runtime-session.ts";

const TASK_MEMORY_CATEGORY = "task-memory";
const TASK_MEMORY_FILE_NAME = "records.json";
const TASK_MEMORY_SUMMARY_MAX_CHARS = 220;

export function createFileSystemTaskMemoryStore(options: {
  readonly agentId: string;
  readonly filePath?: string | undefined;
  readonly rootDir?: string | undefined;
  readonly summaryMaxChars?: number | undefined;
}): TaskMemoryStore {
  const storage =
    options.filePath === undefined
      ? createExecutionFileStorage({
          agentId: options.agentId,
          rootDir: options.rootDir,
        })
      : createSingleFileStorage({
          agentId: options.agentId,
          filePath: options.filePath,
        });

  return createTaskMemoryStore({
    summaryMaxChars: options.summaryMaxChars,
    readRecords: storage.readRecords,
    writeRecords: storage.writeRecords,
  });
}

function createSingleFileStorage(options: { readonly agentId: string; readonly filePath: string }) {
  const filePath = resolveMemoryFilePath({
    category: TASK_MEMORY_CATEGORY,
    agentId: options.agentId,
    fileName: TASK_MEMORY_FILE_NAME,
    filePath: options.filePath,
  });

  return {
    readRecords: async () => {
      return parseTaskMemoryRecords(await readJsonFile<unknown>(filePath, [])).map(cloneRecord);
    },
    writeRecords: async (records: readonly TaskMemoryRecord[]) => {
      await writeJsonFile(filePath, records.map(cloneRecord));
    },
  };
}

function createExecutionFileStorage(options: {
  readonly agentId: string;
  readonly rootDir?: string | undefined;
}) {
  const rootDir = resolveMemoryDirectory({
    category: TASK_MEMORY_CATEGORY,
    agentId: options.agentId,
    rootDir: options.rootDir,
  });

  return {
    readRecords: async () => {
      const executionIds = await listExecutionIds(rootDir);
      const nestedRecords = await Promise.all(
        executionIds.map(async (executionId) => {
          const stored = parseTaskMemoryRecords(
            await readJsonFile<unknown>(resolveExecutionRecordsPath(rootDir, executionId), []),
          );
          return stored.map(cloneRecord);
        }),
      );

      return nestedRecords.flat();
    },
    writeRecords: async (records: readonly TaskMemoryRecord[]) => {
      const recordsByExecution = new Map<string, TaskMemoryRecord[]>();

      for (const record of records) {
        const executionStorageId = sanitizeMemoryPathSegment(record.executionId);
        const recordsForExecution = recordsByExecution.get(executionStorageId) ?? [];
        recordsForExecution.push(cloneRecord(record));
        recordsByExecution.set(executionStorageId, recordsForExecution);
      }

      await Promise.all(
        [...recordsByExecution.entries()].map(async ([executionStorageId, recordsForExecution]) => {
          await writeJsonFile(
            resolveExecutionRecordsPath(rootDir, executionStorageId),
            recordsForExecution.map(cloneRecord),
          );
        }),
      );

      const existingExecutionIds = await listExecutionIds(rootDir);
      await Promise.all(
        existingExecutionIds
          .filter((executionStorageId) => !recordsByExecution.has(executionStorageId))
          .map(async (executionStorageId) => {
            await rm(resolveExecutionDirectory(rootDir, executionStorageId), {
              recursive: true,
              force: true,
            });
          }),
      );
    },
  };
}

async function listExecutionIds(rootDir: string): Promise<readonly string[]> {
  const executionsDir = join(rootDir, "executions");

  try {
    const entries = await readdir(executionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }

    throw error;
  }
}

function resolveExecutionRecordsPath(rootDir: string, executionId: string): string {
  return join(resolveExecutionDirectory(rootDir, executionId), TASK_MEMORY_FILE_NAME);
}

function resolveExecutionDirectory(rootDir: string, executionId: string): string {
  return join(rootDir, "executions", sanitizeMemoryPathSegment(executionId));
}

function createTaskMemoryStore(options: {
  readonly summaryMaxChars?: number | undefined;
  readonly readRecords: () => Promise<readonly TaskMemoryRecord[]>;
  readonly writeRecords: (records: readonly TaskMemoryRecord[]) => Promise<void>;
}): TaskMemoryStore {
  let mutationLock = Promise.resolve();
  const summaryMaxChars = options.summaryMaxChars ?? TASK_MEMORY_SUMMARY_MAX_CHARS;

  const withMutationLock = async <TValue>(operation: () => Promise<TValue>): Promise<TValue> => {
    const previous = mutationLock;
    let releaseCurrent: (() => void) | undefined;
    mutationLock = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await previous;

    try {
      return await operation();
    } finally {
      releaseCurrent?.();
    }
  };

  return {
    async list(input) {
      const statusFilter =
        input.status === undefined ? undefined : new Set(toReadonlyArray(input.status));
      const filtered = (await options.readRecords())
        .filter((record) => record.executionId === input.executionId)
        .filter((record) => {
          if (!canReadRecord(record, input.actorAgentId)) {
            return false;
          }

          if (input.invocationId !== undefined && record.invocationId !== input.invocationId) {
            return false;
          }

          if (
            input.runtimeSession !== undefined &&
            !sameRuntimeSession(record.runtimeSession, input.runtimeSession)
          ) {
            return false;
          }

          if (input.visibility !== undefined && record.visibility !== input.visibility) {
            return false;
          }

          if (input.ownerAgentId !== undefined && record.ownerAgentId !== input.ownerAgentId) {
            return false;
          }

          if (statusFilter !== undefined && !statusFilter.has(record.status)) {
            return false;
          }

          return true;
        });

      return okMemory(filtered.map(cloneRecord));
    },

    async get(input) {
      const record = (await options.readRecords()).find((item) => item.id === input.id);

      if (record === undefined) {
        return errorMemory("memory_not_found", `Task memory not found: ${input.id}`, {
          id: input.id,
        });
      }

      if (!canReadRecord(record, input.actorAgentId)) {
        return errorMemory("permission_denied", `Task memory is not readable: ${input.id}`, {
          id: input.id,
          actorAgentId: input.actorAgentId,
        });
      }

      return okMemory(cloneRecord(record));
    },

    async append(input) {
      return await withMutationLock(async () => {
        const now = new Date().toISOString();
        const recordId = input.record.id ?? createTaskMemoryId();
        const provenance = {
          createdBy: input.record.provenance?.createdBy ?? input.actorAgentId,
          updatedBy: input.record.provenance?.updatedBy ?? input.actorAgentId,
          source: input.record.provenance?.source,
          createdAt: input.record.provenance?.createdAt ?? now,
          updatedAt: input.record.provenance?.updatedAt ?? now,
          evidence: input.record.provenance?.evidence ?? [],
        };
        const record: TaskMemoryRecord = normalizeTaskRecord(
          parseTaskMemoryRecord({
            ...input.record,
            id: recordId,
            revision: 0,
            provenance,
          }),
          summaryMaxChars,
        );

        const validation = validateRecordForAppend(record, input.actorAgentId);

        if (!validation.ok) {
          return validation;
        }

        const records = await options.readRecords();
        await options.writeRecords([record, ...records.filter((item) => item.id !== record.id)]);
        return okMemory(cloneRecord(record));
      });
    },

    async patch(input) {
      return await withMutationLock(async () => {
        const records = await options.readRecords();
        const existing = records.find((item) => item.id === input.id);

        if (existing === undefined) {
          return errorMemory("memory_not_found", `Task memory not found: ${input.id}`, {
            id: input.id,
          });
        }

        if (!canWriteRecord(existing, input.actorAgentId)) {
          return errorMemory("permission_denied", `Task memory is not writable: ${input.id}`, {
            id: input.id,
            actorAgentId: input.actorAgentId,
          });
        }

        if (existing.revision !== input.expectedRevision) {
          return errorMemory("memory_conflict", `Task memory revision conflict: ${input.id}`, {
            id: input.id,
            expectedRevision: input.expectedRevision,
            actualRevision: existing.revision,
          });
        }

        if (input.patch.items !== undefined && existing.kind !== "todo") {
          return errorMemory("invalid_input", "Only todo task memory can update todo items.", {
            id: input.id,
            kind: existing.kind,
          });
        }

        const updated: TaskMemoryRecord = {
          ...existing,
          ...(input.patch.title === undefined ? {} : { title: input.patch.title }),
          ...(input.patch.content === undefined ? {} : { content: input.patch.content }),
          ...(input.patch.status === undefined ? {} : { status: input.patch.status }),
          ...(input.patch.items === undefined ? {} : { items: [...input.patch.items] }),
          revision: existing.revision + 1,
          provenance: {
            ...existing.provenance,
            updatedBy: input.actorAgentId,
            updatedAt: new Date().toISOString(),
          },
        };
        const normalizedUpdated = normalizeTaskRecord(updated, summaryMaxChars);

        await options.writeRecords([
          normalizedUpdated,
          ...records.filter((item) => item.id !== normalizedUpdated.id),
        ]);

        return okMemory(cloneRecord(normalizedUpdated));
      });
    },

    async archive(input) {
      if (input.executionId === undefined && input.invocationId === undefined) {
        return errorMemory(
          "invalid_input",
          "Archive requires executionId or invocationId. runtimeSession may only be used as an additional filter.",
        );
      }

      return await withMutationLock(async () => {
        const records = await options.readRecords();
        const archived: TaskMemoryRecord[] = [];
        const nextRecords = records.map((record) => {
          if (!canWriteRecord(record, input.actorAgentId)) {
            return record;
          }

          if (input.invocationId !== undefined && record.invocationId !== input.invocationId) {
            return record;
          }

          if (
            input.runtimeSession !== undefined &&
            !sameRuntimeSession(record.runtimeSession, input.runtimeSession)
          ) {
            return record;
          }

          if (input.executionId !== undefined && record.executionId !== input.executionId) {
            return record;
          }

          const nextRecord: TaskMemoryRecord =
            record.status === "archived"
              ? record
              : {
                  ...record,
                  status: "archived",
                  revision: record.revision + 1,
                  provenance: {
                    ...record.provenance,
                    updatedBy: input.actorAgentId,
                    updatedAt: new Date().toISOString(),
                  },
                };

          archived.push(cloneRecord(nextRecord));
          return nextRecord;
        });

        await options.writeRecords(nextRecords);
        return okMemory(archived);
      });
    },

    async retrieveForRuntime(input, runtimeOptions) {
      const activeRecords = (await options.readRecords()).filter(
        (record) => record.executionId === input.executionId && record.status === "active",
      );
      const shared =
        runtimeOptions?.includeShared === false
          ? []
          : activeRecords
              .filter((record) => record.visibility === "shared")
              .filter(
                (record) =>
                  input.invocationId === undefined ||
                  record.invocationId === undefined ||
                  record.invocationId === input.invocationId,
              );
      const privateItems =
        runtimeOptions?.includePrivate === false
          ? []
          : activeRecords.filter(
              (record) =>
                record.visibility === "private" &&
                record.ownerAgentId === input.agentId &&
                (input.invocationId === undefined ||
                  record.invocationId === undefined ||
                  record.invocationId === input.invocationId),
            );
      const maxItems = Math.max(1, runtimeOptions?.maxItems ?? Number.MAX_SAFE_INTEGER);

      return okMemory({
        shared: shared.slice(0, maxItems).map(cloneRecord),
        private: privateItems.slice(0, maxItems).map(cloneRecord),
        combined: [...shared, ...privateItems].slice(0, maxItems).map(cloneRecord),
      });
    },

    async listForSummary(input) {
      const records = (await options.readRecords())
        .map((record) =>
          record.summary === undefined
            ? normalizeTaskRecord(record, summaryMaxChars)
            : cloneRecord(record),
        )
        .filter((record) => canReadRecord(record, input.actorAgentId))
        .sort((left, right) => right.provenance.updatedAt.localeCompare(left.provenance.updatedAt));

      return okMemory(records.map(cloneRecord));
    },
  };
}

function validateRecordForAppend(record: TaskMemoryRecord, actorAgentId: string) {
  if (record.visibility === "private" && record.ownerAgentId !== actorAgentId) {
    return errorMemory(
      "permission_denied",
      "Private task memory must be owned by the writing agent.",
      {
        actorAgentId,
        ownerAgentId: record.ownerAgentId,
      },
    );
  }

  if (record.kind === "todo") {
    if (record.items === undefined) {
      return errorMemory("invalid_input", "Todo task memory requires todo items.");
    }
  } else if (record.items !== undefined) {
    return errorMemory("invalid_input", "Only todo task memory may include todo items.");
  }

  return okMemory(record);
}

function canReadRecord(record: TaskMemoryRecord, actorAgentId: string): boolean {
  return record.visibility === "shared" || record.ownerAgentId === actorAgentId;
}

function canWriteRecord(record: TaskMemoryRecord, actorAgentId: string): boolean {
  return record.visibility === "shared" || record.ownerAgentId === actorAgentId;
}

function createTaskMemoryId(): string {
  return `task-memory-${crypto.randomUUID()}`;
}

function cloneRecord(record: TaskMemoryRecord): TaskMemoryRecord {
  return {
    ...record,
    items: record.items === undefined ? undefined : record.items.map((item) => ({ ...item })),
    tags: record.tags === undefined ? undefined : [...record.tags],
    provenance: {
      ...record.provenance,
      evidence: record.provenance.evidence.map((reference) => ({
        ...reference,
        ...(reference.memory === undefined ? {} : { memory: { ...reference.memory } }),
      })),
    },
  };
}

function toReadonlyArray<TValue>(value: TValue | readonly TValue[]): readonly TValue[] {
  return Array.isArray(value) ? value : [value as TValue];
}

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
