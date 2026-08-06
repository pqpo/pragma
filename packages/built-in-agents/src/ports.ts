import type {
  PragmaAgentChangeSet,
  PragmaAgentEvaluationDraft,
  PragmaAgentEvaluationDraftOperation,
  PragmaAgentEvaluationDraftRunResult,
  PragmaAgentFlowDraft,
  PragmaAgentFlowDraftOperation,
  PragmaAgentDslDocument,
  PragmaAgentExpertOptionCatalog,
  PragmaAgentProjectCommit,
  PragmaAgentPrepareResult,
  PragmaAgentResourceSummary,
  PragmaAgentTask,
  PragmaAgentTaskSummary,
  PragmaAgentTaskWorkItem,
  PragmaAgentAutomationSummary,
} from "./contracts.ts";

export interface PragmaAgentDslProjectPort {
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
    readonly resources: PragmaAgentResourceSummary[];
  }>;
  listExpertOptions(): Promise<PragmaAgentExpertOptionCatalog>;
  read(ref: string): Promise<PragmaAgentDslDocument>;
  prepare(input: {
    readonly expectedProjectRevision: number;
    readonly sources: readonly string[];
  }): Promise<PragmaAgentPrepareResult>;
  createFlowDraft(input: {
    readonly expectedProjectRevision: number;
    readonly metadata: PragmaAgentFlowDraft["resource"]["metadata"];
    readonly input?: PragmaAgentFlowDraft["resource"]["spec"]["input"] | undefined;
    readonly output?: PragmaAgentFlowDraft["resource"]["spec"]["output"] | undefined;
    readonly limits?: PragmaAgentFlowDraft["resource"]["spec"]["limits"] | undefined;
  }): Promise<PragmaAgentFlowDraft>;
  getFlowDraft(draftId: string): Promise<PragmaAgentFlowDraft>;
  updateFlowDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
    readonly operations: readonly PragmaAgentFlowDraftOperation[];
  }): Promise<PragmaAgentFlowDraft>;
  validateFlowDraft(draftId: string): Promise<PragmaAgentFlowDraft>;
  createEvaluationDraft(
    input:
      | {
          readonly mode: "create";
          readonly expectedProjectRevision: number;
          readonly metadata: PragmaAgentEvaluationDraft["resource"]["metadata"];
          readonly targetRef: PragmaAgentEvaluationDraft["resource"]["spec"]["target"]["ref"];
        }
      | {
          readonly mode: "edit";
          readonly expectedProjectRevision: number;
          readonly evaluationRef: string;
        },
  ): Promise<PragmaAgentEvaluationDraft>;
  getEvaluationDraft(draftId: string): Promise<PragmaAgentEvaluationDraft>;
  updateEvaluationDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
    readonly operations: readonly PragmaAgentEvaluationDraftOperation[];
  }): Promise<PragmaAgentEvaluationDraft>;
  runEvaluationDraft(input: {
    readonly draftId: string;
    readonly caseIds: readonly string[];
  }): Promise<PragmaAgentEvaluationDraftRunResult>;
  prepareEvaluationDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
  }): Promise<PragmaAgentPrepareResult>;
  discardEvaluationDraft(draftId: string): Promise<void>;
  prepareFlowDraft(input: {
    readonly draftId: string;
    readonly expectedDraftRevision: number;
    readonly additionalSources?: readonly string[] | undefined;
  }): Promise<PragmaAgentPrepareResult>;
  discardFlowDraft(draftId: string): Promise<void>;
  getChangeSet(changeSetId: string): Promise<PragmaAgentChangeSet>;
  commit(input: {
    readonly changeSetId: string;
    readonly operationId: string;
  }): Promise<PragmaAgentProjectCommit>;
}

export interface PragmaAgentTaskPort {
  list(): Promise<readonly PragmaAgentTaskSummary[]>;
  get(id: string): Promise<PragmaAgentTask>;
  submit(input: {
    readonly goal: string;
    readonly executorRef: string;
    readonly workspaceId: string;
    readonly operationId: string;
  }): Promise<PragmaAgentTask>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly operationId: string;
  }): Promise<PragmaAgentTask>;
  listWorkItems(id: string): Promise<readonly PragmaAgentTaskWorkItem[]>;
  interrupt(id: string): Promise<PragmaAgentTask>;
}

export interface PragmaAgentAutomationPort {
  list(): Promise<{
    readonly projectRevision: number;
    readonly automations: readonly PragmaAgentAutomationSummary[];
  }>;
  save(input: {
    readonly expectedProjectRevision: number;
    readonly source: string;
    readonly workspaceId: string;
    readonly toolPermissionMode: "request-approval" | "auto-approve" | "full-access";
    readonly operationId: string;
  }): Promise<PragmaAgentAutomationSummary>;
  delete(input: {
    readonly expectedProjectRevision: number;
    readonly ref: string;
    readonly operationId: string;
  }): Promise<{ readonly deleted: true; readonly ref: string }>;
  resetSession(input: {
    readonly ref: string;
    readonly operationId: string;
  }): Promise<PragmaAgentAutomationSummary>;
}
