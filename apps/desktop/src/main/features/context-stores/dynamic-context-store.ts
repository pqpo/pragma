import type {
  ExpertAgentRunContext,
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
} from "@pragma/core";

export type DynamicContextStoreOperation = "list" | "read" | "add" | "edit" | "delete" | "search";

export type DynamicContextStoreResolver = (
  operation: DynamicContextStoreOperation,
  context: ExpertAgentRunContext | undefined,
) => Promise<ExpertAgentContextResult<ExpertAgentContextStore>>;

/**
 * Keeps a stable Context namespace in an Invocation while resolving its backing store per call.
 * This is intentionally a router, not a cache: Host ownership and lifecycle checks therefore see
 * mutations that happen after the Invocation's initial Context bindings were assembled.
 */
export class DynamicContextStore implements ExpertAgentContextStore {
  constructor(private readonly resolve: DynamicContextStoreResolver) {}

  async listContext(
    input: ExpertAgentContextItemListInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    const resolved = await this.resolve("list", input.context);
    return resolved.ok ? await resolved.value.listContext(input) : resolved;
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    const resolved = await this.resolve("read", input.context);
    return resolved.ok ? await resolved.value.readContext(input) : resolved;
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    const resolved = await this.resolve("add", input.context);
    return resolved.ok ? await resolved.value.addContext(input) : resolved;
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    const resolved = await this.resolve("edit", input.context);
    return resolved.ok ? await resolved.value.editContext(input) : resolved;
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    const resolved = await this.resolve("delete", input.context);
    return resolved.ok ? await resolved.value.deleteContext(input) : resolved;
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const resolved = await this.resolve("search", input.context);
    return resolved.ok ? await resolved.value.searchContext(input) : resolved;
  }
}
