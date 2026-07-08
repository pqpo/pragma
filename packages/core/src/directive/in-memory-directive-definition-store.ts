import type { DirectiveDefinitionRecord, DirectiveDefinitionStore } from "./types.ts";

export function createInMemoryDirectiveDefinitionStore(): DirectiveDefinitionStore {
  const records = new Map<string, DirectiveDefinitionRecord>();

  return {
    async save(record) {
      records.set(record.workflowRunId, record as DirectiveDefinitionRecord);
    },

    async get(workflowRunId) {
      return records.get(workflowRunId);
    },

    async delete(workflowRunId) {
      records.delete(workflowRunId);
    },
  };
}
