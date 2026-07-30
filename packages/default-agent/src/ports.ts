import type {
  DefaultAgentChangeSet,
  DefaultAgentEvaluationDraft,
  DefaultAgentEvaluationDraftOperation,
  DefaultAgentEvaluationDraftRunResult,
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
  allocateResourceIds(
    requests: readonly {
      readonly key: string;
      readonly kind:
        | "expert"
        | "team"
        | "flow"
        | "automation"
        | "capability"
        | "context-store"
        | "runtime-profile"
        | "evaluation";
    }[],
  ): Promise<readonly { readonly key: string; readonly id: string; readonly ref: string }[]>;
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
  createEvaluationDraft(
    input:
      | {
          readonly mode: "create";
          readonly expectedProjectRevision: number;
          readonly metadata: DefaultAgentEvaluationDraft["resource"]["metadata"];
          readonly targetRef: DefaultAgentEvaluationDraft["resource"]["spec"]["target"]["ref"];
        }
      | {
          readonly mode: "edit";
          readonly expectedProjectRevision: number;
          readonly evaluationRef: string;
        },
  ): Promise<DefaultAgentEvaluationDraft>;
  getEvaluationDraft(draftId: string): Promise<DefaultAgentEvaluationDraft>;
  updateEvaluationDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
    readonly operations: readonly DefaultAgentEvaluationDraftOperation[];
  }): Promise<DefaultAgentEvaluationDraft>;
  runEvaluationDraft(input: {
    readonly draftId: string;
    readonly caseIds: readonly string[];
  }): Promise<DefaultAgentEvaluationDraftRunResult>;
  prepareEvaluationDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
  }): Promise<DefaultAgentPrepareResult>;
  discardEvaluationDraft(draftId: string): Promise<void>;
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
