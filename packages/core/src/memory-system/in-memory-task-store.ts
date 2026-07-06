import {
  errorMemory,
  okMemory,
} from "./types.ts";
import type {
  TaskMemoryRecord,
  TaskMemoryStore,
} from "./types.ts";

export function createInMemoryTaskMemoryStore(): TaskMemoryStore {
  const records = new Map<string, TaskMemoryRecord>();
  const idsByWorkflowRunId = new Map<string, string[]>();

  const listRecordsByWorkflowRunId = (workflowRunId: string): TaskMemoryRecord[] =>
    (idsByWorkflowRunId.get(workflowRunId) ?? [])
      .map((id) => records.get(id))
      .filter((record): record is TaskMemoryRecord => record !== undefined);

  const saveRecord = (record: TaskMemoryRecord): TaskMemoryRecord => {
    records.set(record.id, record);
    const ids = idsByWorkflowRunId.get(record.workflowRunId) ?? [];

    if (!ids.includes(record.id)) {
      ids.push(record.id);
      idsByWorkflowRunId.set(record.workflowRunId, ids);
    }

    return cloneRecord(record);
  };

  return {
    async list(input) {
      const statusFilter =
        input.status === undefined ? undefined : new Set(toReadonlyArray(input.status));
      const filtered = listRecordsByWorkflowRunId(input.workflowRunId).filter((record) => {
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
      const record = records.get(input.id);

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

      return okMemory(saveRecord(record));
    },

    async patch(input) {
      const existing = records.get(input.id);

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

      return okMemory(saveRecord(updated));
    },

    async archive(input) {
      if (
        input.workflowRunId === undefined &&
        input.taskRunId === undefined &&
        input.runtimeSessionId === undefined
      ) {
        return errorMemory("invalid_input", "Archive requires at least one task memory scope.");
      }

      const workflowIds =
        input.workflowRunId === undefined ? [...idsByWorkflowRunId.keys()] : [input.workflowRunId];
      const archived: TaskMemoryRecord[] = [];

      for (const workflowRunId of workflowIds) {
        for (const record of listRecordsByWorkflowRunId(workflowRunId)) {
          if (!canWriteRecord(record, input.actorAgentId)) {
            continue;
          }

          if (input.taskRunId !== undefined && record.taskRunId !== input.taskRunId) {
            continue;
          }

          if (
            input.runtimeSessionId !== undefined &&
            record.runtimeSessionId !== input.runtimeSessionId
          ) {
            continue;
          }

          if (input.workflowRunId !== undefined && record.workflowRunId !== input.workflowRunId) {
            continue;
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

          archived.push(saveRecord(nextRecord));
        }
      }

      return okMemory(archived);
    },

    async retrieveForRuntime(input, options) {
      const activeRecords = input.workflowRunId === undefined
        ? []
        : listRecordsByWorkflowRunId(input.workflowRunId).filter((record) => record.status === "active");
      const shared = options?.includeShared === false
        ? []
        : activeRecords
            .filter((record) => record.visibility === "shared")
            .filter((record) =>
              input.taskRunId === undefined || record.taskRunId === undefined || record.taskRunId === input.taskRunId
            );
      const privateItems = options?.includePrivate === false
        ? []
        : activeRecords.filter(
            (record) =>
              record.visibility === "private" &&
              record.ownerAgentId === input.agentId &&
              (input.taskRunId === undefined ||
                record.taskRunId === undefined ||
                record.taskRunId === input.taskRunId),
          );
      const maxItems = Math.max(1, options?.maxItems ?? Number.MAX_SAFE_INTEGER);

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
    tags: record.tags === undefined ? undefined : [...record.tags],
    items: record.items === undefined ? undefined : record.items.map((item) => ({ ...item })),
    provenance: {
      ...record.provenance,
      evidence: [...record.provenance.evidence],
    },
  };
}

function toReadonlyArray<TValue>(value: TValue | readonly TValue[]): readonly TValue[] {
  return Array.isArray(value) ? value : ([value] as readonly TValue[]);
}
