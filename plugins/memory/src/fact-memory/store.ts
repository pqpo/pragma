import {
  errorMemory,
  okMemory,
  type FactMemoryRecord,
  type FactMemoryStore,
  type MemoryConfidence,
} from "../memory-system/index.ts";

export function createInMemoryFactMemoryStore(): FactMemoryStore {
  const records = new Map<string, FactMemoryRecord>();

  return {
    async list(input) {
      return okMemory(
        listRecords(records).filter((record) => {
          if (input.scope !== undefined && record.scope !== input.scope) {
            return false;
          }

          if (input.confidenceAtLeast !== undefined) {
            const minWeight = confidenceWeight(input.confidenceAtLeast);

            if (confidenceWeight(record.confidence) < minWeight) {
              return false;
            }
          }

          if (input.onlyActive === true && !isActiveFact(record)) {
            return false;
          }

          if (input.tags !== undefined && input.tags.some((tag) => !record.tags?.includes(tag))) {
            return false;
          }

          return true;
        }),
      );
    },

    async get(input) {
      const record = records.get(input.id);

      return record === undefined
        ? errorMemory("memory_not_found", `Fact memory not found: ${input.id}`, {
            id: input.id,
          })
        : okMemory(cloneFactRecord(record));
    },

    async write(input) {
      const validation = validateFactRecord(input.record);

      if (!validation.ok) {
        return validation;
      }

      const record = cloneFactRecord(input.record);
      records.set(record.id, record);
      return okMemory(record);
    },

    async update(input) {
      const existing = records.get(input.record.id);

      if (existing === undefined) {
        return errorMemory("memory_not_found", `Fact memory not found: ${input.record.id}`, {
          id: input.record.id,
        });
      }

      const merged = cloneFactRecord({
        ...input.record,
        provenance: {
          ...input.record.provenance,
          createdAt: existing.provenance.createdAt,
          createdBy: existing.provenance.createdBy,
        },
      });
      const validation = validateFactRecord(merged);

      if (!validation.ok) {
        return validation;
      }

      records.set(merged.id, merged);
      return okMemory(merged);
    },

    async delete(input) {
      if (!records.has(input.id)) {
        return errorMemory("memory_not_found", `Fact memory not found: ${input.id}`, {
          id: input.id,
        });
      }

      records.delete(input.id);
      return okMemory({ id: input.id });
    },

    async search(input) {
      const query = input.query.trim().toLowerCase();
      const matches = listRecords(records)
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

          return toSearchText(record).includes(query);
        })
        .map((record) => ({
          record: cloneFactRecord(record),
          score: query.length === 0 ? confidenceWeight(record.confidence) : computeScore(record, query),
          excerpt: record.statement,
        }))
        .sort((left, right) => {
          if ((right.score ?? 0) !== (left.score ?? 0)) {
            return (right.score ?? 0) - (left.score ?? 0);
          }

          return compareFacts(left.record, right.record);
        })
        .slice(0, Math.max(1, input.pagination?.limit ?? Number.MAX_SAFE_INTEGER));

      return okMemory(matches);
    },

    async retrieveForRuntime(input, options) {
      const query = input.query?.trim().toLowerCase() ?? "";
      const result = listRecords(records)
        .filter((record) => isActiveFact(record))
        .filter((record) => {
          if (query.length === 0) {
            return true;
          }

          return toSearchText(record).includes(query);
        })
        .sort(compareFacts)
        .slice(0, Math.max(1, options?.maxItems ?? Number.MAX_SAFE_INTEGER))
        .map(cloneFactRecord);

      return okMemory(result);
    },
  };
}

function validateFactRecord(record: FactMemoryRecord) {
  if (record.provenance.evidence.length === 0) {
    return errorMemory("invalid_input", "Fact memory requires at least one evidence reference.");
  }

  return okMemory(record);
}

function listRecords(records: ReadonlyMap<string, FactMemoryRecord>): FactMemoryRecord[] {
  return [...records.values()].sort(compareFacts);
}

function isActiveFact(record: FactMemoryRecord): boolean {
  if (record.invalidatedAt !== undefined) {
    return false;
  }

  if (record.supersededBy !== undefined) {
    return false;
  }

  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()) {
    return false;
  }

  return true;
}

function computeScore(record: FactMemoryRecord, query: string): number {
  let score = confidenceWeight(record.confidence) * 10;

  if (record.statement.toLowerCase().includes(query)) {
    score += 5;
  }

  if (record.title?.toLowerCase().includes(query) === true) {
    score += 4;
  }

  if (record.summary?.toLowerCase().includes(query) === true) {
    score += 3;
  }

  if (record.tags?.some((tag) => tag.toLowerCase().includes(query)) === true) {
    score += 2;
  }

  return score;
}

function compareFacts(left: FactMemoryRecord, right: FactMemoryRecord): number {
  const verifiedDelta = Number(right.verifiedAt !== undefined) - Number(left.verifiedAt !== undefined);

  if (verifiedDelta !== 0) {
    return verifiedDelta;
  }

  const confidenceDelta = confidenceWeight(right.confidence) - confidenceWeight(left.confidence);

  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return right.observedAt.localeCompare(left.observedAt);
}

function confidenceWeight(confidence: MemoryConfidence): number {
  switch (confidence) {
    case "verified":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

function toSearchText(record: FactMemoryRecord): string {
  return [
    record.statement,
    record.title,
    record.summary,
    ...(record.tags ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}

function cloneFactRecord(record: FactMemoryRecord): FactMemoryRecord {
  return {
    ...record,
    tags: record.tags === undefined ? undefined : [...record.tags],
    conflictsWith:
      record.conflictsWith === undefined
        ? undefined
        : record.conflictsWith.map((reference) => ({ ...reference })),
    supersededBy:
      record.supersededBy === undefined ? undefined : { ...record.supersededBy },
    provenance: {
      ...record.provenance,
      evidence: [...record.provenance.evidence],
    },
  };
}
