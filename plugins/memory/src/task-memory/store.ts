import { errorMemory, okMemory, type TaskMemoryRecord, type TaskMemoryStore } from "../memory-system/index.ts";
import { readJsonFile, resolveMemoryFilePath, writeJsonFile } from "../storage.ts";

const TASK_MEMORY_CATEGORY = "task-memory";
const TASK_MEMORY_FILE_NAME = "records.json";

export function createFileSystemTaskMemoryStore(options: {
  readonly agentId: string;
  readonly filePath?: string | undefined;
}): TaskMemoryStore {
  const filePath = resolveMemoryFilePath({
    category: TASK_MEMORY_CATEGORY,
    agentId: options.agentId,
    fileName: TASK_MEMORY_FILE_NAME,
    filePath: options.filePath,
  });

  return createTaskMemoryStore({
    readRecords: async () => {
      const stored = await readJsonFile<readonly TaskMemoryRecord[]>(filePath, []);
      return stored.map(cloneRecord);
    },
    writeRecords: async (records) => {
      await writeJsonFile(filePath, records.map(cloneRecord));
    },
  });
}

function createTaskMemoryStore(options: {
  readonly readRecords: () => Promise<readonly TaskMemoryRecord[]>;
  readonly writeRecords: (records: readonly TaskMemoryRecord[]) => Promise<void>;
}): TaskMemoryStore {
  let mutationLock = Promise.resolve();

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
        .filter((record) => record.workflowRunId === input.workflowRunId)
        .filter((record) => {
          if (!canReadRecord(record, input.actorAgentId)) {
            return false;
          }

          if (input.taskRunId !== undefined && record.taskRunId !== input.taskRunId) {
            return false;
          }

          if (
            input.runtimeSessionId !== undefined &&
            record.runtimeSessionId !== input.runtimeSessionId
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
        const record: TaskMemoryRecord = {
          ...input.record,
          id: input.record.id ?? createTaskMemoryId(),
          revision: 0,
          provenance: {
            createdBy: input.record.provenance?.createdBy ?? input.actorAgentId,
            updatedBy: input.record.provenance?.updatedBy ?? input.actorAgentId,
            source: input.record.provenance?.source,
            createdAt: input.record.provenance?.createdAt ?? now,
            updatedAt: input.record.provenance?.updatedAt ?? now,
            evidence: input.record.provenance?.evidence ?? [],
          },
        };

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

        await options.writeRecords([
          updated,
          ...records.filter((item) => item.id !== updated.id),
        ]);

        return okMemory(cloneRecord(updated));
      });
    },

    async archive(input) {
      if (
        input.workflowRunId === undefined &&
        input.taskRunId === undefined &&
        input.runtimeSessionId === undefined
      ) {
        return errorMemory("invalid_input", "Archive requires at least one task memory scope.");
      }

      return await withMutationLock(async () => {
        const records = await options.readRecords();
        const archived: TaskMemoryRecord[] = [];
        const nextRecords = records.map((record) => {
          if (!canWriteRecord(record, input.actorAgentId)) {
            return record;
          }

          if (input.taskRunId !== undefined && record.taskRunId !== input.taskRunId) {
            return record;
          }

          if (
            input.runtimeSessionId !== undefined &&
            record.runtimeSessionId !== input.runtimeSessionId
          ) {
            return record;
          }

          if (input.workflowRunId !== undefined && record.workflowRunId !== input.workflowRunId) {
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
        (record) =>
          record.workflowRunId === input.workflowRunId &&
          record.status === "active",
      );
      const shared = runtimeOptions?.includeShared === false
        ? []
        : activeRecords
            .filter((record) => record.visibility === "shared")
            .filter((record) =>
              input.taskRunId === undefined ||
              record.taskRunId === undefined ||
              record.taskRunId === input.taskRunId
            );
      const privateItems = runtimeOptions?.includePrivate === false
        ? []
        : activeRecords.filter(
            (record) =>
              record.visibility === "private" &&
              record.ownerAgentId === input.agentId &&
              (input.taskRunId === undefined ||
                record.taskRunId === undefined ||
                record.taskRunId === input.taskRunId),
          );
      const maxItems = Math.max(1, runtimeOptions?.maxItems ?? Number.MAX_SAFE_INTEGER);

      return okMemory({
        shared: shared.slice(0, maxItems).map(cloneRecord),
        private: privateItems.slice(0, maxItems).map(cloneRecord),
        combined: [...shared, ...privateItems].slice(0, maxItems).map(cloneRecord),
      });
    },
  };
}

function validateRecordForAppend(
  record: TaskMemoryRecord,
  actorAgentId: string,
) {
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
      evidence: [...record.provenance.evidence],
    },
  };
}

function toReadonlyArray<TValue>(value: TValue | readonly TValue[]): readonly TValue[] {
  return Array.isArray(value) ? value : [value as TValue];
}
