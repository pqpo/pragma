import {
  errorMemory,
  okMemory,
  type FactMemoryRecord,
  type FactMemoryStore,
  type MemoryConfidence,
} from "../memory-system/index.ts";
import { readJsonFile, resolveMemoryFilePath, writeJsonFile } from "../storage.ts";

const FACT_MEMORY_CATEGORY = "fact-memory";
const FACT_MEMORY_FILE_NAME = "records.json";

export function createFileSystemFactMemoryStore(options: {
  readonly agentId: string;
  readonly filePath?: string | undefined;
}): FactMemoryStore {
  const filePath = resolveMemoryFilePath({
    category: FACT_MEMORY_CATEGORY,
    agentId: options.agentId,
    fileName: FACT_MEMORY_FILE_NAME,
    filePath: options.filePath,
  });

  return createFactMemoryStore({
    readRecords: async () => {
      const stored = await readJsonFile<readonly FactMemoryRecord[]>(filePath, []);
      return stored.map(cloneFactRecord).sort(compareFacts);
    },
    writeRecords: async (records) => {
      await writeJsonFile(filePath, records.map(cloneFactRecord));
    },
  });
}

function createFactMemoryStore(options: {
  readonly readRecords: () => Promise<readonly FactMemoryRecord[]>;
  readonly writeRecords: (records: readonly FactMemoryRecord[]) => Promise<void>;
}): FactMemoryStore {
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
      const records = await options.readRecords();

      return okMemory(
        records.filter((record) => {
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
      const record = (await options.readRecords()).find((item) => item.id === input.id);

      return record === undefined
        ? errorMemory("memory_not_found", `Fact memory not found: ${input.id}`, {
            id: input.id,
          })
        : okMemory(cloneFactRecord(record));
    },

    async write(input) {
      return await withMutationLock(async () => {
        const validation = validateFactRecord(input.record);

        if (!validation.ok) {
          return validation;
        }

        const records = await options.readRecords();
        const record = cloneFactRecord(input.record);
        await options.writeRecords([
          record,
          ...records.filter((existing) => existing.id !== record.id),
        ]);

        return okMemory(record);
      });
    },

    async update(input) {
      return await withMutationLock(async () => {
        const records = await options.readRecords();
        const existing = records.find((item) => item.id === input.record.id);

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

        await options.writeRecords([
          merged,
          ...records.filter((record) => record.id !== merged.id),
        ]);

        return okMemory(merged);
      });
    },

    async delete(input) {
      return await withMutationLock(async () => {
        const records = await options.readRecords();

        if (!records.some((record) => record.id === input.id)) {
          return errorMemory("memory_not_found", `Fact memory not found: ${input.id}`, {
            id: input.id,
          });
        }

        await options.writeRecords(records.filter((record) => record.id !== input.id));
        return okMemory({ id: input.id });
      });
    },

    async search(input) {
      const query = input.query.trim().toLowerCase();
      const matches = (await options.readRecords())
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

    async retrieveForRuntime(input, optionsInput) {
      const query = input.query?.trim().toLowerCase() ?? "";
      const result = (await options.readRecords())
        .filter((record) => isActiveFact(record))
        .filter((record) => {
          if (query.length === 0) {
            return true;
          }

          return toSearchText(record).includes(query);
        })
        .sort(compareFacts)
        .slice(0, Math.max(1, optionsInput?.maxItems ?? Number.MAX_SAFE_INTEGER))
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
