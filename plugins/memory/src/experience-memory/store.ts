import {
  errorMemory,
  okMemory,
  type ExperienceMemoryRecord,
  type ExperienceMemoryStore,
  type MemorySearchInput,
} from "../memory-system/index.ts";

export function createInMemoryExperienceMemoryStore(): ExperienceMemoryStore {
  const records = new Map<string, ExperienceMemoryRecord>();

  return {
    async list(input) {
      return okMemory(
        listRecords(records).filter((record) => {
          if (input.workflowRunId !== undefined && record.workflowRunId !== input.workflowRunId) {
            return false;
          }

          if (input.taskRunId !== undefined && record.taskRunId !== input.taskRunId) {
            return false;
          }

          if (input.runtimeSessionId !== undefined && record.runtimeSessionId !== input.runtimeSessionId) {
            return false;
          }

          if (input.status !== undefined && record.status !== input.status) {
            return false;
          }

          if (input.kind !== undefined && record.kind !== input.kind) {
            return false;
          }

          return true;
        }),
      );
    },

    async get(input) {
      const record = records.get(input.id);

      return record === undefined
        ? errorMemory("memory_not_found", `Experience memory not found: ${input.id}`, {
            id: input.id,
          })
        : okMemory(cloneExperienceRecord(record));
    },

    async write(input) {
      const validation = validateExperienceRecord(input.record);

      if (!validation.ok) {
        return validation;
      }

      const record = withExperienceDefaults(input.record);
      records.set(record.id, record);
      return okMemory(cloneExperienceRecord(record));
    },

    async update(input) {
      const existing = records.get(input.record.id);

      if (existing === undefined) {
        return errorMemory("memory_not_found", `Experience memory not found: ${input.record.id}`, {
          id: input.record.id,
        });
      }

      const merged: ExperienceMemoryRecord = withExperienceDefaults({
        ...input.record,
        provenance: {
          ...input.record.provenance,
          createdAt: existing.provenance.createdAt,
          createdBy: existing.provenance.createdBy,
        },
      });
      const validation = validateExperienceRecord(merged);

      if (!validation.ok) {
        return validation;
      }

      records.set(merged.id, merged);
      return okMemory(cloneExperienceRecord(merged));
    },

    async delete(input) {
      if (!records.has(input.id)) {
        return errorMemory("memory_not_found", `Experience memory not found: ${input.id}`, {
          id: input.id,
        });
      }

      records.delete(input.id);
      return okMemory({ id: input.id });
    },

    async search(input) {
      const filtered = scoreExperienceMatches(listRecords(records), input).slice(
        0,
        Math.max(1, input.pagination?.limit ?? Number.MAX_SAFE_INTEGER),
      );

      return okMemory(filtered);
    },

    async retrieveForRuntime(input, options) {
      const query = input.query?.trim().toLowerCase() ?? "";
      const matches = scoreExperienceMatches(listRecords(records), {
        query: input.query ?? "",
      });
      const relevant = matches
        .filter(({ record }) => {
          if (input.runtimeSessionId !== undefined && record.runtimeSessionId === input.runtimeSessionId) {
            return true;
          }

          if (input.taskRunId !== undefined && record.taskRunId === input.taskRunId) {
            return true;
          }

          if (input.workflowRunId !== undefined && record.workflowRunId === input.workflowRunId) {
            return true;
          }

          return query.length > 0 && (record.content.toLowerCase().includes(query) ||
            record.summary?.toLowerCase().includes(query) === true ||
            record.title?.toLowerCase().includes(query) === true);
        })
        .sort((left, right) => {
          const statusDelta = experienceStatusWeight(right.record.status) - experienceStatusWeight(left.record.status);

          if (statusDelta !== 0) {
            return statusDelta;
          }

          if ((right.score ?? 0) !== (left.score ?? 0)) {
            return (right.score ?? 0) - (left.score ?? 0);
          }

          return right.record.provenance.updatedAt.localeCompare(left.record.provenance.updatedAt);
        })
        .slice(0, Math.max(1, options?.maxItems ?? Number.MAX_SAFE_INTEGER))
        .map(({ record }) => cloneExperienceRecord(record));

      return okMemory(relevant);
    },
  };
}

function listRecords(records: ReadonlyMap<string, ExperienceMemoryRecord>): ExperienceMemoryRecord[] {
  return [...records.values()].sort((left, right) =>
    right.provenance.updatedAt.localeCompare(left.provenance.updatedAt),
  );
}

function scoreExperienceMatches(
  records: readonly ExperienceMemoryRecord[],
  input: MemorySearchInput,
) {
  const query = input.query.trim().toLowerCase();

  return records
    .filter((record) => {
      if (input.scope !== undefined && record.scope !== input.scope) {
        return false;
      }

      if (input.tags !== undefined && input.tags.some((tag) => !record.tags?.includes(tag))) {
        return false;
      }

      if (query.length === 0) {
        return true;
      }

      return toExperienceSearchText(record).includes(query);
    })
    .map((record) => ({
      record: cloneExperienceRecord(record),
      score: query.length === 0 ? 0 : computeExperienceScore(record, query),
      excerpt: record.summary ?? record.content.slice(0, 240),
    }))
    .sort((left, right) => {
      if ((right.score ?? 0) !== (left.score ?? 0)) {
        return (right.score ?? 0) - (left.score ?? 0);
      }

      return right.record.provenance.updatedAt.localeCompare(left.record.provenance.updatedAt);
    });
}

function computeExperienceScore(record: ExperienceMemoryRecord, query: string): number {
  const haystack = toExperienceSearchText(record);
  let score = 0;

  if (record.summary?.toLowerCase().includes(query) === true) {
    score += 4;
  }

  if (record.title?.toLowerCase().includes(query) === true) {
    score += 3;
  }

  if (record.content.toLowerCase().includes(query)) {
    score += 2;
  }

  if (record.tags?.some((tag) => tag.toLowerCase().includes(query)) === true) {
    score += 1;
  }

  if (haystack.includes(query)) {
    score += 1;
  }

  return score;
}

function validateExperienceRecord(record: ExperienceMemoryRecord) {
  if (record.provenance.evidence.length === 0) {
    return errorMemory(
      "invalid_input",
      "Experience memory requires at least one evidence reference.",
    );
  }

  return okMemory(record);
}

function withExperienceDefaults(record: ExperienceMemoryRecord): ExperienceMemoryRecord {
  const now = new Date().toISOString();

  return {
    ...record,
    provenance: {
      ...record.provenance,
      createdAt: record.provenance.createdAt,
      updatedAt: record.provenance.updatedAt ?? now,
      evidence: [...record.provenance.evidence],
    },
  };
}

function toExperienceSearchText(record: ExperienceMemoryRecord): string {
  return [
    record.title,
    record.summary,
    record.content,
    ...(record.tags ?? []),
    record.kind,
    record.workflowRunId,
    record.taskRunId,
    record.runtimeSessionId,
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}

function experienceStatusWeight(status: ExperienceMemoryRecord["status"]): number {
  switch (status) {
    case "promoted":
      return 3;
    case "summarized":
      return 2;
    case "recorded":
    default:
      return 1;
  }
}

function cloneExperienceRecord(record: ExperienceMemoryRecord): ExperienceMemoryRecord {
  return {
    ...record,
    tags: record.tags === undefined ? undefined : [...record.tags],
    provenance: {
      ...record.provenance,
      evidence: [...record.provenance.evidence],
    },
  };
}
