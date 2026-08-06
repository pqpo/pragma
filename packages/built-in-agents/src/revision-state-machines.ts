import {
  ContextStoreChangeSetSchema,
  ContextStoreRevisionJobSchema,
  ProgressiveKnowledgeStoreFilesSchema,
  SkillRevisionJobSchema,
  type ContextStoreChangeSet,
  type ContextStoreRevisionJob,
  type ContextStoreRevisionSnapshot,
  type SkillEvaluationSnapshot,
  type SkillRevisionChangeSet,
  type SkillRevisionJob,
} from "./revision-contracts.ts";

export type ContextStoreRevisionEvent =
  | { readonly type: "generation_started" }
  | { readonly type: "generation_recovered" }
  | { readonly type: "generation_succeeded"; readonly changeSet: ContextStoreChangeSet }
  | { readonly type: "generation_failed"; readonly code: string; readonly message: string }
  | { readonly type: "approved" }
  | { readonly type: "rejected" }
  | { readonly type: "retried" }
  | { readonly type: "apply_succeeded" }
  | { readonly type: "apply_failed"; readonly code: string; readonly message: string }
  | { readonly type: "superseded"; readonly replacementId: string };

export function transitionContextStoreRevisionJob(
  current: ContextStoreRevisionJob,
  event: ContextStoreRevisionEvent,
  updatedAt = new Date().toISOString(),
): ContextStoreRevisionJob {
  const next = (() => {
    switch (event.type) {
      case "generation_started":
        requireState(current.state, ["pending"]);
        return { ...current, state: "running" as const };
      case "generation_recovered":
        requireState(current.state, ["running"]);
        return { ...current, state: "pending" as const, changeSet: undefined, error: undefined };
      case "generation_succeeded":
        requireState(current.state, ["running"]);
        return {
          ...current,
          state: "pending_review" as const,
          changeSet: ContextStoreChangeSetSchema.parse(event.changeSet),
          error: undefined,
        };
      case "generation_failed":
        requireState(current.state, ["running"]);
        return { ...current, state: "needs_attention" as const, error: errorOf(event) };
      case "approved":
        requireState(current.state, ["pending_review"]);
        if (current.changeSet === undefined) throw new Error("revision_changeset_missing");
        return { ...current, state: "applying" as const };
      case "rejected":
        requireState(current.state, ["pending_review"]);
        return { ...current, state: "rejected" as const };
      case "retried":
        requireState(current.state, ["needs_attention", "rejected"]);
        return { ...current, state: "pending" as const, changeSet: undefined, error: undefined };
      case "apply_succeeded":
        requireState(current.state, ["applying"]);
        return { ...current, state: "completed" as const, error: undefined };
      case "apply_failed":
        requireState(current.state, ["applying"]);
        return { ...current, state: "needs_attention" as const, error: errorOf(event) };
      case "superseded":
        requireState(current.state, ["applying"]);
        return { ...current, state: "superseded" as const, supersededBy: event.replacementId };
    }
  })();
  return ContextStoreRevisionJobSchema.parse({
    ...next,
    revision: current.revision + 1,
    updatedAt,
  });
}

export type SkillRevisionEvent =
  | { readonly type: "generation_started" }
  | { readonly type: "generation_succeeded"; readonly changeSet: SkillRevisionChangeSet }
  | { readonly type: "evaluation_succeeded"; readonly evaluation: SkillEvaluationSnapshot }
  | { readonly type: "processing_failed"; readonly code: string; readonly message: string }
  | { readonly type: "approved" }
  | { readonly type: "rejected" }
  | { readonly type: "retried" }
  | { readonly type: "apply_succeeded" }
  | { readonly type: "apply_failed"; readonly code: string; readonly message: string }
  | { readonly type: "superseded"; readonly replacementId: string };

export function transitionSkillRevisionJob(
  current: SkillRevisionJob,
  event: SkillRevisionEvent,
  updatedAt = new Date().toISOString(),
): SkillRevisionJob {
  const next = (() => {
    switch (event.type) {
      case "generation_started":
        requireState(current.state, ["pending"]);
        return { ...current, state: "running" as const };
      case "generation_succeeded":
        requireState(current.state, ["running"]);
        return { ...current, state: "evaluating" as const, changeSet: event.changeSet };
      case "evaluation_succeeded":
        requireState(current.state, ["evaluating"]);
        return event.evaluation.passed
          ? {
              ...current,
              state: "pending_review" as const,
              evaluation: event.evaluation,
              error: undefined,
            }
          : {
              ...current,
              state: "needs_attention" as const,
              evaluation: event.evaluation,
              error: {
                code: "skill_evaluation_failed",
                message: "The proposed Skill revision did not pass evaluation.",
              },
            };
      case "processing_failed":
        requireState(current.state, ["running", "evaluating"]);
        return { ...current, state: "needs_attention" as const, error: errorOf(event) };
      case "approved":
        requireState(current.state, ["pending_review"]);
        if (current.changeSet === undefined || current.evaluation?.passed !== true) {
          throw new Error("skill_revision_approval_invalid");
        }
        return { ...current, state: "applying" as const };
      case "rejected":
        requireState(current.state, ["pending_review"]);
        return { ...current, state: "rejected" as const };
      case "retried":
        requireState(current.state, ["needs_attention"]);
        return {
          ...current,
          state: "pending" as const,
          changeSet: undefined,
          evaluation: undefined,
          error: undefined,
        };
      case "apply_succeeded":
        requireState(current.state, ["applying"]);
        return { ...current, state: "completed" as const, error: undefined };
      case "apply_failed":
        requireState(current.state, ["applying"]);
        return { ...current, state: "needs_attention" as const, error: errorOf(event) };
      case "superseded":
        requireState(current.state, ["applying"]);
        return { ...current, state: "superseded" as const, supersededBy: event.replacementId };
    }
  })();
  return SkillRevisionJobSchema.parse({
    ...next,
    revision: current.revision + 1,
    updatedAt,
  });
}

export function attachContextStoreBaseContent(
  base: ContextStoreRevisionSnapshot,
  rawChangeSet: ContextStoreChangeSet,
): ContextStoreChangeSet {
  const files = new Map(base.files.map((file) => [file.id, file]));
  const changeSet = ContextStoreChangeSetSchema.parse(rawChangeSet);
  return ContextStoreChangeSetSchema.parse({
    ...changeSet,
    operations: changeSet.operations.map((operation) => {
      if (operation.operation === "rename") return operation;
      return { ...operation, previousContent: files.get(operation.id)?.content };
    }),
  });
}

export function assertProgressiveKnowledgeStructure(
  base: ContextStoreRevisionSnapshot,
  changeSet: ContextStoreChangeSet,
): void {
  const baseIds = new Set(base.files.map((file) => file.id));
  if (
    !baseIds.has("guide.md") ||
    !baseIds.has("overview.md") ||
    !baseIds.has("index.md") ||
    !base.files.some((file) => file.id.startsWith("items/"))
  )
    return;
  const projected = new Map(base.files.map((file) => [file.id, file]));
  for (const operation of changeSet.operations) {
    if (operation.operation === "delete") projected.delete(operation.id);
    else if (operation.operation === "rename") {
      const current = projected.get(operation.id);
      if (current !== undefined) {
        projected.delete(operation.id);
        projected.set(operation.nextId, { ...current, id: operation.nextId });
      }
    } else {
      projected.set(operation.id, {
        id: operation.id,
        content: operation.content,
        metadata: operation.metadata,
      });
    }
  }
  ProgressiveKnowledgeStoreFilesSchema.parse([...projected.values()]);
}

function requireState(current: string, allowed: readonly string[]): void {
  if (!allowed.includes(current)) throw new Error(`revision_state_invalid:${current}`);
}

function errorOf(event: { readonly code: string; readonly message: string }): {
  readonly code: string;
  readonly message: string;
} {
  return { code: event.code, message: event.message };
}
