import type {
  ExpertAgentContextItemListInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSummary,
  ExpertAgentContextResult,
  ExpertAgentContextStore,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextItemDeleteInput,
  ExpertAgentStoredContextItemEditInput,
  ExpertAgentStoredContextItemEditResult,
  ExpertAgentStoredContextItemReadInput,
  ExpertAgentStoredContextItemReadResult,
  ExpertAgentStoredContextItemSearchInput,
  ExpertAgentStoredContextRegisterInput,
} from "./context-system.ts";
import { error } from "./context-system.ts";

/** Exposes an existing Context Store through a strictly read-only capability boundary. */
export class ReadOnlyContextStore implements ExpertAgentContextStore {
  constructor(private readonly store: ExpertAgentContextStore) {}

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    return await this.store.listContext(input);
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    return await this.store.readContext(input);
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    return await this.store.searchContext(input);
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    return denied("add", input.id);
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    return denied("edit", input.id);
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    return denied("delete", input.id);
  }
}

function denied<T>(operation: string, id: string): ExpertAgentContextResult<T> {
  return error("permission_denied", `Read-only Context Store does not allow ${operation}: ${id}`, {
    id,
    operation,
  });
}
