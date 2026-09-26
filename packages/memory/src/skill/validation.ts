import type { SkillSourceRevisionRef, SkillSourceSnapshot } from "@pragma/shared";

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
