import type {
  ExistingMemorySkillTarget,
  SkillSourceRevisionRef,
  SkillSourceSnapshot,
} from "@pragma/shared";

import type { SkillLearningPlan } from "../learning/revision-plan.ts";

export interface SkillSourceEligibility {
  readonly eligible: boolean;
  readonly highValueEpisodicCount: number;
  readonly conversationCount: number;
  readonly successfulOrRecoveredCount: number;
  readonly qualifyingSourceRefs: readonly SkillSourceRevisionRef[];
}

export function inspectSkillSourceEligibility(
  sources: readonly SkillSourceSnapshot[],
): SkillSourceEligibility {
  const currentEpisodes = new Map<string, SkillSourceSnapshot>();
  for (const source of sources) {
    if (source.ref.kind !== "episodic") continue;
    const current = currentEpisodes.get(source.ref.id);
    if (current === undefined || source.ref.revision > current.ref.revision) {
      currentEpisodes.set(source.ref.id, source);
    }
  }
  const episodes = [...currentEpisodes.values()].filter(
    (source) => (source.valueScore ?? 0) >= 0.85,
  );
  const conversations = new Set(
    episodes
      .map((source) =>
        source.conversationRef === undefined
          ? undefined
          : `${source.conversationRef.type}\0${source.conversationRef.id}`,
      )
      .filter(Boolean),
  );
  const successful = episodes.filter(
    (source) => source.outcome === "succeeded" || source.hasSuccessfulRecovery,
  );
  return {
    eligible: episodes.length >= 3 && conversations.size >= 2 && successful.length >= 2,
    highValueEpisodicCount: episodes.length,
    conversationCount: conversations.size,
    successfulOrRecoveredCount: successful.length,
    qualifyingSourceRefs: episodes
      .map((source) => source.ref)
      .toSorted((left, right) => left.id.localeCompare(right.id) || left.revision - right.revision),
  };
}

export function skillSourceThresholdMet(sources: readonly SkillSourceSnapshot[]): boolean {
  return inspectSkillSourceEligibility(sources).eligible;
}

export interface SkillPlanValidationIssue {
  readonly index: number;
  readonly message: string;
}

export function inspectSkillLearningPlan(
  plan: SkillLearningPlan,
  sources: readonly SkillSourceSnapshot[],
  targets: readonly ExistingMemorySkillTarget[],
): readonly SkillPlanValidationIssue[] {
  if (plan.action === "skip") return [];
  const available = new Map(sources.map((source) => [sourceRefKey(source.ref), source]));
  const acceptedKeys = new Set<string>();
  return plan.changes.flatMap((change, index) => {
    const issues: string[] = [];
    const keys = change.sourceRefs.map(sourceRefKey);
    const selected = keys.map((key) => available.get(key));
    if (new Set(keys).size !== keys.length) issues.push("sourceRefs must be distinct.");
    if (selected.some((source) => source === undefined)) {
      issues.push("Cite only exact supplied sourceRefs, including revision.");
    } else {
      const eligibility = inspectSkillSourceEligibility(selected as SkillSourceSnapshot[]);
      if (!eligibility.eligible)
        issues.push(
          `Each change requires at least 3 distinct Episodes with valueScore >= 0.85 from at least 2 conversations, including at least 2 successful or recovered outcomes. Selected counts: ${eligibility.highValueEpisodicCount} high-value Episodes, ${eligibility.conversationCount} conversations, ${eligibility.successfulOrRecoveredCount} successful or recovered outcomes.`,
        );
    }
    const target = change.target;
    const owners = targets.filter((item) => item.normalizedKeys.includes(change.normalizedKey));
    if (
      target.type === "create"
        ? owners.length > 0
        : !targets.some((item) => item.capabilityId === target.capabilityId) ||
          owners.some((item) => item.capabilityId !== target.capabilityId)
    ) {
      issues.push("Use a supplied target ID and do not claim another target's normalizedKey.");
    }
    if (acceptedKeys.has(change.normalizedKey)) issues.push("All normalizedKeys must be distinct.");
    if (issues.length === 0) acceptedKeys.add(change.normalizedKey);
    return issues.map((message) => ({ index, message }));
  });
}

export function qualifyingSkillLearningPlan(
  plan: SkillLearningPlan,
  sources: readonly SkillSourceSnapshot[],
  targets: readonly ExistingMemorySkillTarget[],
): SkillLearningPlan {
  if (plan.action === "skip") return plan;
  const invalid = new Set(
    inspectSkillLearningPlan(plan, sources, targets).map((issue) => issue.index),
  );
  const changes = plan.changes.filter((_, index) => !invalid.has(index));
  return changes.length === 0 ? { action: "skip" } : { action: "apply", changes };
}

function sourceRefKey(ref: SkillSourceRevisionRef): string {
  return `${ref.kind}\0${ref.id}\0${ref.revision}`;
}
