import { error, type ExpertAgentContextStore } from "@pragma/core";

import {
  ContextStoreChangeSetSchema,
  type ContextStoreChangeSet,
  type ContextStoreRevisionProfile,
  type ContextStoreRevisionRequest,
  type ContextStoreRevisionSnapshot,
} from "./revision-contracts.ts";
import { extractStructuredJson } from "./structured-output.ts";

export interface StoreRevisionExecutionPort {
  generate(input: {
    readonly jobId: string;
    readonly storeId: string;
    readonly title: string;
    readonly prompt: string;
    readonly profile: ContextStoreRevisionProfile;
  }): Promise<{ readonly content: string }>;
}

export interface StoreRevisionGenerator {
  generate(input: {
    readonly jobId: string;
    readonly request: ContextStoreRevisionRequest;
    readonly profile: ContextStoreRevisionProfile;
    readonly snapshot: ContextStoreRevisionSnapshot;
  }): Promise<ContextStoreChangeSet>;
}

export function createBuiltInStoreRevisionGenerator(options: {
  readonly execution: StoreRevisionExecutionPort;
}): StoreRevisionGenerator {
  return {
    async generate(input) {
      const output = await options.execution.generate({
        jobId: input.jobId,
        storeId: input.request.storeId,
        title: `Revise knowledge base ${input.request.storeId.slice(0, 8)}`,
        prompt: renderStoreRevisionPrompt(input),
        profile: input.profile,
      });
      return ContextStoreChangeSetSchema.parse(JSON.parse(extractStructuredJson(output.content)));
    },
  };
}

export function renderStoreRevisionPrompt(input: {
  readonly request: ContextStoreRevisionRequest;
  readonly snapshot: ContextStoreRevisionSnapshot;
}): string {
  return [
    "Prepare a reviewable revision of the target Context Store.",
    `Store id: ${input.request.storeId}`,
    `Base revision: ${input.snapshot.revision}`,
    `Base snapshot hash: ${input.snapshot.snapshotHash}`,
    "Use target-store list/search/read to inspect only what is needed.",
    "Revision request:",
    input.request.prompt,
    "Required JSON shape:",
    '{"schemaVersion":"pragma.context-store-change-set/v1","storeId":"...","baseRevision":1,"baseSnapshotHash":"64 hex","summary":"...","operations":[{"operation":"upsert","id":"items/example.md","content":"...","metadata":{"trigger":"model_decision","priority":"normal"}},{"operation":"rename","id":"old.md","nextId":"new.md"},{"operation":"delete","id":"obsolete.md"}]}',
  ].join("\n\n");
}

export function readOnlyContextStore(store: ExpertAgentContextStore): ExpertAgentContextStore {
  const denied = async () => error("permission_denied", "The Store Revision Agent is read-only.");
  return {
    listContext: async (input) => await store.listContext(input),
    readContext: async (input) => await store.readContext(input),
    searchContext: async (input) => await store.searchContext(input),
    addContext: denied,
    editContext: denied,
    deleteContext: denied,
  };
}
