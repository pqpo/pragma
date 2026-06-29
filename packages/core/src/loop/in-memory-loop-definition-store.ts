import type { LoopDefinitionRecord, LoopDefinitionStore } from "./types.ts";

export function createInMemoryLoopDefinitionStore(): LoopDefinitionStore {
  const records = new Map<string, LoopDefinitionRecord>();

  return {
    async save(record) {
      records.set(record.workflowRunId, record as LoopDefinitionRecord);
    },

    async get(workflowRunId) {
      return records.get(workflowRunId);
    },

    async delete(workflowRunId) {
      records.delete(workflowRunId);
    },
  };
}
