import type {
  KnowledgeSourceSnapshot,
  SkillSourceSnapshot,
  MemorySubjectRef,
} from "@pragma/shared";
import type { LearningDecision } from "./decision-store.ts";

/** A durable Revision execution result, never an intermediate model-authored plan. */
export interface MemoryRevisionExecutionResult {
  readonly decision: Omit<LearningDecision, "schemaVersion">;
  readonly submitted: boolean;
}

export interface MemoryRevisionExecutor {
  retireJob?(jobId: string): Promise<void>;
  maintain?(retainedJobIds: readonly string[]): Promise<void>;
  /** Keyed admission fact for this Expert and source digest; false proves no admission for this key. */
  hasExecution?(input: {
    readonly kind: "knowledge" | "skill";
    readonly jobId: string;
    readonly expertRef: string;
    readonly sourceDigest: string;
  }): Promise<boolean>;
  /** Confirms the complete job index: partial or missing reservation/owner records are not proof. */
  canObserveJob?(jobId: string): Promise<boolean>;
  execute(input: {
    readonly kind: "knowledge" | "skill";
    readonly jobId: string;
    readonly claimRevision: number;
    readonly manualRetry: boolean;
    readonly retryFailedExecution?: boolean;
    readonly onAdmission?: (admitted: boolean) => void;
    readonly rootRef: MemorySubjectRef;
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly sources: readonly (KnowledgeSourceSnapshot | SkillSourceSnapshot)[];
    readonly signal: AbortSignal;
    /** Recheck the live claim, policy and source authorization at every tool boundary. */
    readonly assertCurrent: () => Promise<void>;
  }): Promise<MemoryRevisionExecutionResult>;
}
