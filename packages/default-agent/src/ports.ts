import type {
  DefaultAgentChangeSet,
  DefaultAgentDslDocument,
  DefaultAgentExpertOptionCatalog,
  DefaultAgentProjectCommit,
  DefaultAgentResourceSummary,
  DefaultAgentTask,
  DefaultAgentTaskSummary,
  DefaultAgentTaskWorkItem,
} from "./contracts.ts";

export interface DefaultAgentDslProjectPort {
  list(): Promise<{
    readonly projectRevision: number;
    readonly resources: DefaultAgentResourceSummary[];
  }>;
  listExpertOptions(): Promise<DefaultAgentExpertOptionCatalog>;
  read(ref: string): Promise<DefaultAgentDslDocument>;
  prepare(input: {
    readonly expectedProjectRevision: number;
    readonly sources: readonly string[];
  }): Promise<DefaultAgentChangeSet>;
  getChangeSet(changeSetId: string): Promise<DefaultAgentChangeSet>;
  commit(input: {
    readonly changeSetId: string;
    readonly operationId: string;
  }): Promise<DefaultAgentProjectCommit>;
}

export interface DefaultAgentTaskPort {
  list(): Promise<readonly DefaultAgentTaskSummary[]>;
  get(id: string): Promise<DefaultAgentTask>;
  submit(input: {
    readonly goal: string;
    readonly executorRef: string;
    readonly workspaceId: string;
    readonly operationId: string;
  }): Promise<DefaultAgentTask>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly operationId: string;
  }): Promise<DefaultAgentTask>;
  listWorkItems(id: string): Promise<readonly DefaultAgentTaskWorkItem[]>;
  interrupt(id: string): Promise<DefaultAgentTask>;
}
