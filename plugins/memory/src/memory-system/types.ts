import type { ExpertAgentRunContext } from "@pragma/core";

export type MemoryType = "task" | "experience" | "fact" | "skill";

export type MemoryRecordSchemaVersion =
  | "pragma.memory-task/v1"
  | "pragma.memory-experience/v1"
  | "pragma.memory-fact/v1"
  | "pragma.memory-skill/v1";

export type MemoryEvidenceSchemaVersion = "pragma.memory-evidence/v1";

export type MemoryScope = "run" | "session" | "agent" | "workspace" | "organization";

export type MemoryVisibility = "shared" | "private";

export type MemoryConfidence = "low" | "medium" | "high" | "verified";

export interface MemoryReference {
  readonly type: MemoryType;
  readonly id: string;
}

export interface MemoryEvidenceReference {
  readonly type:
    | "context"
    | "event"
    | "message"
    | "run"
    | "workflow"
    | "task"
    | "tool"
    | "memory"
    | "external";
  readonly id: string;
  readonly label?: string | undefined;
  readonly uri?: string | undefined;
  readonly memory?: MemoryReference | undefined;
}

export interface MemoryProvenance {
  readonly createdBy?: string | undefined;
  readonly updatedBy?: string | undefined;
  readonly source?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly evidence: readonly MemoryEvidenceReference[];
}

export interface MemoryRuntimeControl {
  readonly trigger: "always_on" | "model_decision" | "manual";
  readonly priority?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export interface BaseMemoryRecord {
  readonly schemaVersion: MemoryRecordSchemaVersion;
  readonly id: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly runtime?: MemoryRuntimeControl | undefined;
  readonly provenance: MemoryProvenance;
}

export type MemoryRecordWriteInput<TRecord extends BaseMemoryRecord> = Omit<
  TRecord,
  "schemaVersion"
> & {
  readonly schemaVersion?: TRecord["schemaVersion"] | undefined;
};

export type TaskMemoryKind = "decision" | "handoff" | "note" | "todo" | "progress" | "question";

export interface TaskTodoItem {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly assigneeAgentId?: string | undefined;
}

export interface TaskMemoryRecord extends BaseMemoryRecord {
  readonly type: "task";
  readonly scope: "run" | "session";
  readonly visibility: MemoryVisibility;
  readonly ownerAgentId?: string | undefined;
  readonly workflowRunId: string;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly kind: TaskMemoryKind;
  readonly content: string;
  readonly items?: readonly TaskTodoItem[] | undefined;
  readonly status: "active" | "resolved" | "archived";
  readonly revision: number;
}

export type ExperienceMemoryKind = "conversation" | "recovery" | "run" | "workflow" | "tool";

export interface ExperienceMemoryRecord extends BaseMemoryRecord {
  readonly type: "experience";
  readonly kind: ExperienceMemoryKind;
  readonly content: string;
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly status: "recorded" | "summarized" | "promoted";
}

export interface FactMemoryRecord extends BaseMemoryRecord {
  readonly type: "fact";
  readonly statement: string;
  readonly confidence: MemoryConfidence;
  readonly observedAt: string;
  readonly verifiedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly reviewAt?: string | undefined;
  readonly invalidatedAt?: string | undefined;
  readonly supersededBy?: MemoryReference | undefined;
  readonly conflictsWith?: readonly MemoryReference[] | undefined;
}

export interface SkillMemoryRecord extends BaseMemoryRecord {
  readonly type: "skill";
  readonly problemClass: string;
  readonly recommendedApproach: readonly string[];
  readonly goodPractices: readonly string[];
  readonly antiPatterns: readonly string[];
  readonly failureModes: readonly string[];
  readonly recoveryPlaybook: readonly string[];
  readonly confidence?: MemoryConfidence | undefined;
}

export interface MemoryResultError {
  readonly code:
    | "invalid_input"
    | "memory_not_found"
    | "memory_conflict"
    | "permission_denied"
    | "store_already_registered"
    | "store_unavailable"
    | "store_error";
  readonly message: string;
  readonly details?: unknown;
}

export type MemoryResult<TValue> =
  | {
      readonly ok: true;
      readonly value: TValue;
    }
  | {
      readonly ok: false;
      readonly error: MemoryResultError;
    };

export interface MemoryPagination {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface MemorySearchInput {
  readonly query: string;
  readonly scope?: MemoryScope | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly pagination?: MemoryPagination | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface MemorySearchMatch<TRecord extends BaseMemoryRecord> {
  readonly record: TRecord;
  readonly score?: number | undefined;
  readonly excerpt?: string | undefined;
}

export interface RuntimeMemoryRetrieveInput {
  readonly agentId: string;
  readonly query?: string | undefined;
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly runContext?: ExpertAgentRunContext | undefined;
}

export interface RuntimeMemoryRetrieveOptions {
  readonly task?:
    | {
        readonly includeShared?: boolean | undefined;
        readonly includePrivate?: boolean | undefined;
        readonly maxItems?: number | undefined;
      }
    | undefined;
  readonly experience?:
    | {
        readonly maxItems?: number | undefined;
      }
    | undefined;
  readonly fact?:
    | {
        readonly maxItems?: number | undefined;
      }
    | undefined;
  readonly skill?:
    | {
        readonly maxItems?: number | undefined;
      }
    | undefined;
}

export interface RuntimeMemoryRetrieval {
  readonly task: {
    readonly shared: readonly TaskMemoryRecord[];
    readonly private: readonly TaskMemoryRecord[];
    readonly combined: readonly TaskMemoryRecord[];
  };
  readonly experiences: readonly ExperienceMemoryRecord[];
  readonly facts: readonly FactMemoryRecord[];
  readonly skills: readonly SkillMemoryRecord[];
}

export type MemoryEvidenceKind = "task_archive" | "run" | "workflow";

export interface MemoryTaskArchiveEvidencePayload {
  readonly task: TaskMemoryRecord;
}

export interface MemoryRunEvidencePayload {
  readonly query: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "running";
  readonly outputExcerpt?: string | undefined;
  readonly errorMessage?: string | undefined;
  readonly lessons: readonly string[];
  readonly tools: readonly {
    readonly toolName: string;
    readonly status: "started" | "completed" | "failed";
    readonly outputExcerpt?: string | undefined;
    readonly errorMessage?: string | undefined;
  }[];
}

export interface MemoryWorkflowEvidencePayload {
  readonly workflowRunId: string;
  readonly runtimeSessionIds: readonly string[];
  readonly runIds: readonly string[];
  readonly externalContext: boolean;
  readonly runs: readonly MemoryRunEvidencePayload[];
}

export type MemoryEvidencePayload =
  | MemoryTaskArchiveEvidencePayload
  | MemoryRunEvidencePayload
  | MemoryWorkflowEvidencePayload;

export interface MemoryEvidenceRecord {
  readonly schemaVersion: MemoryEvidenceSchemaVersion;
  readonly id: string;
  readonly type: "evidence";
  readonly kind: MemoryEvidenceKind;
  readonly agentId: string;
  readonly scope: MemoryScope;
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly payload: MemoryEvidencePayload;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provenance: MemoryProvenance;
}

export type MemoryEvidenceRecordWriteInput = Omit<MemoryEvidenceRecord, "schemaVersion"> & {
  readonly schemaVersion?: MemoryEvidenceSchemaVersion | undefined;
};

export interface TaskMemoryAppendInput {
  readonly actorAgentId: string;
  readonly record: Omit<
    MemoryRecordWriteInput<TaskMemoryRecord>,
    "id" | "provenance" | "revision"
  > & {
    readonly id?: string | undefined;
    readonly provenance?: Partial<MemoryProvenance> | undefined;
    readonly revision?: never;
  };
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface TaskMemoryPatchInput {
  readonly id: string;
  readonly actorAgentId: string;
  readonly expectedRevision: number;
  readonly patch: {
    readonly title?: string | undefined;
    readonly content?: string | undefined;
    readonly status?: TaskMemoryRecord["status"] | undefined;
    readonly items?: readonly TaskTodoItem[] | undefined;
  };
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface TaskMemoryGetInput {
  readonly id: string;
  readonly actorAgentId: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface TaskMemoryListInput {
  readonly workflowRunId: string;
  readonly actorAgentId: string;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly visibility?: MemoryVisibility | undefined;
  readonly ownerAgentId?: string | undefined;
  readonly status?: TaskMemoryRecord["status"] | readonly TaskMemoryRecord["status"][] | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface TaskMemoryArchiveInput {
  readonly actorAgentId: string;
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface MemoryEvidenceWriteInput {
  readonly record: MemoryEvidenceRecordWriteInput;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface MemoryEvidenceGetInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface MemoryEvidenceListInput {
  readonly kind?: MemoryEvidenceKind | undefined;
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExperienceMemoryGetInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExperienceMemoryListInput {
  readonly workflowRunId?: string | undefined;
  readonly taskRunId?: string | undefined;
  readonly runtimeSessionId?: string | undefined;
  readonly status?: ExperienceMemoryRecord["status"] | undefined;
  readonly kind?: ExperienceMemoryKind | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface FactMemoryGetInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface FactMemoryListInput {
  readonly scope?: MemoryScope | undefined;
  readonly confidenceAtLeast?: MemoryConfidence | undefined;
  readonly onlyActive?: boolean | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface SkillMemoryGetInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface SkillMemoryListInput {
  readonly scope?: MemoryScope | undefined;
  readonly problemClass?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface TaskMemoryStore {
  readonly list: (input: TaskMemoryListInput) => Promise<MemoryResult<readonly TaskMemoryRecord[]>>;
  readonly get: (input: TaskMemoryGetInput) => Promise<MemoryResult<TaskMemoryRecord>>;
  readonly append: (input: TaskMemoryAppendInput) => Promise<MemoryResult<TaskMemoryRecord>>;
  readonly patch: (input: TaskMemoryPatchInput) => Promise<MemoryResult<TaskMemoryRecord>>;
  readonly archive: (
    input: TaskMemoryArchiveInput,
  ) => Promise<MemoryResult<readonly TaskMemoryRecord[]>>;
  readonly retrieveForRuntime: (
    input: RuntimeMemoryRetrieveInput,
    options?: RuntimeMemoryRetrieveOptions["task"] | undefined,
  ) => Promise<
    MemoryResult<{
      readonly shared: readonly TaskMemoryRecord[];
      readonly private: readonly TaskMemoryRecord[];
      readonly combined: readonly TaskMemoryRecord[];
    }>
  >;
  readonly listForSummary: (input: {
    readonly actorAgentId: string;
  }) => Promise<MemoryResult<readonly TaskMemoryRecord[]>>;
}

export interface MemoryEvidenceStore {
  readonly list: (
    input: MemoryEvidenceListInput,
  ) => Promise<MemoryResult<readonly MemoryEvidenceRecord[]>>;
  readonly get: (input: MemoryEvidenceGetInput) => Promise<MemoryResult<MemoryEvidenceRecord>>;
  readonly write: (input: MemoryEvidenceWriteInput) => Promise<MemoryResult<MemoryEvidenceRecord>>;
}

export interface ExperienceMemoryStore {
  readonly list: (
    input: ExperienceMemoryListInput,
  ) => Promise<MemoryResult<readonly ExperienceMemoryRecord[]>>;
  readonly get: (input: ExperienceMemoryGetInput) => Promise<MemoryResult<ExperienceMemoryRecord>>;
  readonly upsert: (
    record: MemoryRecordWriteInput<ExperienceMemoryRecord>,
  ) => Promise<MemoryResult<ExperienceMemoryRecord>>;
  readonly search: (
    input: MemorySearchInput,
  ) => Promise<MemoryResult<readonly MemorySearchMatch<ExperienceMemoryRecord>[]>>;
  readonly retrieveForRuntime: (
    input: RuntimeMemoryRetrieveInput,
    options?: RuntimeMemoryRetrieveOptions["experience"] | undefined,
  ) => Promise<MemoryResult<readonly ExperienceMemoryRecord[]>>;
}

export interface FactMemoryStore {
  readonly list: (input: FactMemoryListInput) => Promise<MemoryResult<readonly FactMemoryRecord[]>>;
  readonly get: (input: FactMemoryGetInput) => Promise<MemoryResult<FactMemoryRecord>>;
  readonly upsert: (
    record: MemoryRecordWriteInput<FactMemoryRecord>,
  ) => Promise<MemoryResult<FactMemoryRecord>>;
  readonly search: (
    input: MemorySearchInput,
  ) => Promise<MemoryResult<readonly MemorySearchMatch<FactMemoryRecord>[]>>;
  readonly retrieveForRuntime: (
    input: RuntimeMemoryRetrieveInput,
    options?: RuntimeMemoryRetrieveOptions["fact"] | undefined,
  ) => Promise<MemoryResult<readonly FactMemoryRecord[]>>;
}

export interface SkillMemoryStore {
  readonly list: (
    input: SkillMemoryListInput,
  ) => Promise<MemoryResult<readonly SkillMemoryRecord[]>>;
  readonly get: (input: SkillMemoryGetInput) => Promise<MemoryResult<SkillMemoryRecord>>;
  readonly upsert: (
    record: MemoryRecordWriteInput<SkillMemoryRecord>,
  ) => Promise<MemoryResult<SkillMemoryRecord>>;
  readonly search: (
    input: MemorySearchInput,
  ) => Promise<MemoryResult<readonly MemorySearchMatch<SkillMemoryRecord>[]>>;
  readonly retrieveForRuntime: (
    input: RuntimeMemoryRetrieveInput,
    options?: RuntimeMemoryRetrieveOptions["skill"] | undefined,
  ) => Promise<MemoryResult<readonly SkillMemoryRecord[]>>;
}

export interface MemoryStoreRegistration<TStore> {
  readonly store: TStore;
}

export interface MemorySystemOptions {
  readonly taskStore?: TaskMemoryStore | undefined;
  readonly evidenceStore?: MemoryEvidenceStore | undefined;
  readonly experienceStore?: ExperienceMemoryStore | undefined;
  readonly factStore?: FactMemoryStore | undefined;
  readonly skillStore?: SkillMemoryStore | undefined;
  readonly distillation?: MemoryDistillationPipeline | undefined;
  readonly onDistillationError?: ((error: MemoryResultError) => void) | undefined;
  readonly summaryConfig?: Partial<import("./summary.ts").MemorySummaryConfig> | undefined;
}

export interface MemorySystemRuntimeRetrieveInput {
  readonly request: RuntimeMemoryRetrieveInput;
  readonly options?: RuntimeMemoryRetrieveOptions | undefined;
}

export interface MemoryDistillationCandidate<
  TMemoryType extends "experience" | "fact" | "skill",
  TRecord,
> {
  readonly type: TMemoryType;
  readonly record: TRecord;
  readonly derivedFrom: readonly MemoryReference[];
}

export interface MemoryDistillationInput {
  readonly evidence: readonly MemoryEvidenceRecord[];
}

export interface MemoryDistillationProposal {
  readonly experiences: readonly MemoryDistillationCandidate<
    "experience",
    ExperienceMemoryRecord
  >[];
  readonly facts: readonly MemoryDistillationCandidate<"fact", FactMemoryRecord>[];
  readonly skills: readonly MemoryDistillationCandidate<"skill", SkillMemoryRecord>[];
}

export interface MemoryDistillationPipeline {
  readonly distill: (
    input: MemoryDistillationInput,
  ) => Promise<MemoryResult<MemoryDistillationProposal>> | MemoryResult<MemoryDistillationProposal>;
}

export function okMemory<TValue>(value: TValue): MemoryResult<TValue> {
  return {
    ok: true,
    value,
  };
}

export function errorMemory<TValue>(
  code: MemoryResultError["code"],
  message: string,
  details?: unknown,
): MemoryResult<TValue> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}
