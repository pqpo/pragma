import type {
  StewardChangeSet,
  StewardDslDocument,
  StewardExpertOptionCatalog,
  StewardProjectCommit,
  StewardResourceSummary,
  StewardSessionState,
  StewardTask,
  StewardTaskSummary,
  StewardTaskWorkItem,
} from "./contracts.ts";

export interface StewardDslProjectPort {
  list(): Promise<{
    readonly projectRevision: number;
    readonly resources: StewardResourceSummary[];
  }>;
  listExpertOptions(): Promise<StewardExpertOptionCatalog>;
  read(ref: string): Promise<StewardDslDocument>;
  prepare(input: {
    readonly expectedProjectRevision: number;
    readonly sources: readonly string[];
  }): Promise<StewardChangeSet>;
  getChangeSet(changeSetId: string): Promise<StewardChangeSet>;
  commit(input: {
    readonly changeSetId: string;
    readonly operationId: string;
  }): Promise<StewardProjectCommit>;
}

export interface StewardTaskPort {
  list(): Promise<readonly StewardTaskSummary[]>;
  get(id: string): Promise<StewardTask>;
  submit(input: {
    readonly goal: string;
    readonly executorRef: string;
    readonly workspaceId: string;
    readonly operationId: string;
  }): Promise<StewardTask>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly operationId: string;
  }): Promise<StewardTask>;
  listWorkItems(id: string): Promise<readonly StewardTaskWorkItem[]>;
  interrupt(id: string): Promise<StewardTask>;
}

export interface StewardStateRepository {
  get(): Promise<StewardSessionState | undefined>;
  put(state: StewardSessionState): Promise<void>;
  clear(): Promise<void>;
}
