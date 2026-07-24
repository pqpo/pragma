import type {
  DefaultAgentChangeSet,
  DefaultAgentFlowDraft,
  DefaultAgentFlowDraftOperation,
  DefaultAgentDslDocument,
  DefaultAgentExpertOptionCatalog,
  DefaultAgentProjectCommit,
  DefaultAgentPrepareResult,
  DefaultAgentResourceSummary,
  DefaultAgentTask,
  DefaultAgentTaskSummary,
  DefaultAgentTaskWorkItem,
  DefaultAgentAutomationSummary,
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
  }): Promise<DefaultAgentPrepareResult>;
  createFlowDraft(input: {
    readonly expectedProjectRevision: number;
    readonly metadata: DefaultAgentFlowDraft["resource"]["metadata"];
    readonly input?: DefaultAgentFlowDraft["resource"]["spec"]["input"] | undefined;
    readonly output?: DefaultAgentFlowDraft["resource"]["spec"]["output"] | undefined;
    readonly limits?: DefaultAgentFlowDraft["resource"]["spec"]["limits"] | undefined;
  }): Promise<DefaultAgentFlowDraft>;
  getFlowDraft(draftId: string): Promise<DefaultAgentFlowDraft>;
  updateFlowDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
    readonly operations: readonly DefaultAgentFlowDraftOperation[];
  }): Promise<DefaultAgentFlowDraft>;
  validateFlowDraft(draftId: string): Promise<DefaultAgentFlowDraft>;
  prepareFlowDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
    readonly additionalSources?: readonly string[] | undefined;
  }): Promise<DefaultAgentPrepareResult>;
  discardFlowDraft(draftId: string): Promise<void>;
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

export interface DefaultAgentAutomationPort {
  list(): Promise<{
    readonly projectRevision: number;
    readonly automations: readonly DefaultAgentAutomationSummary[];
  }>;
  save(input: {
    readonly expectedProjectRevision: number;
    readonly source: string;
    readonly workspaceId: string;
    readonly toolPermissionMode: "request-approval" | "auto-approve" | "full-access";
    readonly operationId: string;
  }): Promise<DefaultAgentAutomationSummary>;
  delete(input: {
    readonly expectedProjectRevision: number;
    readonly ref: string;
    readonly operationId: string;
  }): Promise<{ readonly deleted: true; readonly ref: string }>;
  resetSession(input: {
    readonly ref: string;
    readonly operationId: string;
  }): Promise<DefaultAgentAutomationSummary>;
}
