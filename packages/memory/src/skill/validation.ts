import type {
  ExistingMemorySkillTarget,
  SkillExtractionCandidate,
  SkillSourceSnapshot,
} from "@pragma/shared";

export interface SkillCandidateValidationIssue {
  readonly path: string;
  readonly code:
    | "source_ref_not_found"
    | "source_threshold_not_met"
    | "route_binding_not_found"
    | "route_binding_duplicate"
    | "normalized_key_duplicate";
  readonly message: string;
}

export function skillSourceThresholdMet(sources: readonly SkillSourceSnapshot[]): boolean {
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
  return episodes.length >= 3 && conversations.size >= 2 && successful.length >= 2;
}

export function validateSkillExtractionCandidate(
  candidate: SkillExtractionCandidate,
  sources: readonly SkillSourceSnapshot[],
  targets: readonly ExistingMemorySkillTarget[],
  acceptedNormalizedKeys: ReadonlySet<string> = new Set(),
): readonly SkillCandidateValidationIssue[] {
  const issues: SkillCandidateValidationIssue[] = [];
  const available = new Map(sources.map((source) => [sourceKey(source), source]));
  const selected = candidate.sourceRefs.flatMap((ref, index) => {
    const source = available.get(`${ref.kind}\0${ref.id}\0${ref.revision}`);
    if (source !== undefined) return [source];
    issues.push({
      path: `sourceRefs[${index}]`,
      code: "source_ref_not_found",
      message: "The source revision is not present in this extraction input.",
    });
    return [];
  });
  if (selected.length === candidate.sourceRefs.length && !skillSourceThresholdMet(selected)) {
    issues.push({
      path: "sourceRefs",
      code: "source_threshold_not_met",
      message:
        "The candidate must cite three high-value Episodic sources across two conversations, including two successful or recovered outcomes.",
    });
  }

  const targetIds = new Set(targets.map((target) => target.bindingId));
  const bindingIds =
    candidate.route.type === "revise"
      ? [candidate.route.bindingId]
      : candidate.route.type === "ambiguous"
        ? candidate.route.bindingIds
        : [];
  for (const [index, bindingId] of bindingIds.entries()) {
    if (targetIds.has(bindingId)) continue;
    issues.push({
      path: candidate.route.type === "revise" ? "route.bindingId" : `route.bindingIds[${index}]`,
      code: "route_binding_not_found",
      message: "The route binding is not present in the supplied existing targets.",
    });
  }
  if (candidate.route.type === "ambiguous" && new Set(bindingIds).size !== bindingIds.length) {
    issues.push({
      path: "route.bindingIds",
      code: "route_binding_duplicate",
      message: "Ambiguous routes must name distinct supplied bindings.",
    });
  }
  if (acceptedNormalizedKeys.has(candidate.content.normalizedKey)) {
    issues.push({
      path: "content.normalizedKey",
      code: "normalized_key_duplicate",
      message: "A submitted candidate already uses this normalized key.",
    });
  }
  return issues;
}

function sourceKey(source: SkillSourceSnapshot): string {
  return `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`;
}
