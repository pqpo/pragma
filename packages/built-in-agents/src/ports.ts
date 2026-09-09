import type {
  PragmaAgentChangeSet,
  PragmaAgentEvaluationDraft,
  PragmaAgentEvaluationDraftOperation,
  PragmaAgentEvaluationDraftRunResult,
  PragmaAgentFlowDraft,
  PragmaAgentFlowDraftOperation,
  PragmaAgentDslDocument,
  PragmaAgentProjectCommit,
  PragmaAgentPrepareResult,
  PragmaAgentResourceSummary,
  PragmaAgentMission,
  PragmaAgentMissionSummary,
  PragmaAgentMissionWorkItem,
  PragmaAgentMissionWorkItemDetail,
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
  list(input: {
    readonly cursor?: string | undefined;
    readonly limit: number;
    readonly kinds?: readonly PragmaAgentResourceSummary["kind"][] | undefined;
    readonly query?: string | undefined;
  }): Promise<{
    readonly projectRevision: number;
    readonly items: PragmaAgentResourceSummary[];
    readonly nextCursor?: string | undefined;
  }>;
  listExpertOptions(input: {
    readonly category: "runtime-models" | "capabilities" | "avatars" | "builtin-experts";
    readonly cursor?: string | undefined;
    readonly limit: number;
    readonly query?: string | undefined;
    readonly capabilityKind?: "skill" | "tools" | undefined;
  }): Promise<{
    readonly category: "runtime-models" | "capabilities" | "avatars" | "builtin-experts";
    readonly items: readonly unknown[];
    readonly nextCursor?: string | undefined;
  }>;
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

export interface PragmaAgentMissionPort {
  list(input: {
    readonly cursor?: string | undefined;
    readonly limit: number;
    readonly statuses?: readonly string[] | undefined;
    readonly executorRef?: string | undefined;
    readonly updatedAfter?: string | undefined;
    readonly query?: string | undefined;
  }): Promise<{
    readonly items: readonly PragmaAgentMissionSummary[];
    readonly nextCursor?: string | undefined;
  }>;
  get(missionId: string): Promise<PragmaAgentMission>;
  submit(input: {
    readonly goal: string;
    readonly executorRef: string;
    readonly workspaceId: string;
    readonly operationId: string;
  }): Promise<PragmaAgentMission>;
  sendMessage(input: {
    readonly missionId: string;
    readonly content: string;
    readonly operationId: string;
  }): Promise<PragmaAgentMission>;
  listWorkItems(input: {
    readonly missionId: string;
    readonly cursor?: string | undefined;
    readonly limit: number;
    readonly kinds?: readonly string[] | undefined;
    readonly statuses?: readonly string[] | undefined;
    readonly query?: string | undefined;
  }): Promise<{
    readonly items: readonly PragmaAgentMissionWorkItem[];
    readonly nextCursor?: string | undefined;
  }>;
  getWorkItem(missionId: string, workItemId: string): Promise<PragmaAgentMissionWorkItemDetail>;
  interrupt(missionId: string): Promise<PragmaAgentMission>;
}

export interface PragmaAgentAutomationPort {
  list(input: {
    readonly cursor?: string | undefined;
    readonly limit: number;
    readonly statuses?: readonly PragmaAgentAutomationSummary["status"][] | undefined;
    readonly enabled?: boolean | undefined;
    readonly executorRef?: string | undefined;
    readonly query?: string | undefined;
  }): Promise<{
    readonly projectRevision: number;
    readonly items: readonly PragmaAgentAutomationSummary[];
    readonly nextCursor?: string | undefined;
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
