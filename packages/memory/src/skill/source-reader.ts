import {
  SkillSourceSnapshotSchema,
  type MemorySubjectRef,
  type SkillSourceSnapshot,
} from "@pragma/shared";

import type { EpisodicMemoryStore } from "../episodic/store.ts";
import type { SemanticMemoryStore } from "../semantic/store.ts";

export interface SkillSourceReader {
  listEligibleSources(input: {
    readonly rootRef: MemorySubjectRef;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly SkillSourceSnapshot[]>;
}

export function createSkillSourceReader(options: {
  readonly episodic: Pick<EpisodicMemoryStore, "list">;
  readonly semantic: Pick<SemanticMemoryStore, "list">;
}): SkillSourceReader {
  return {
    async listEligibleSources(input) {
      const [episodes, facts] = await Promise.all([
        options.episodic.list(),
        options.semantic.list(),
      ]);
      const episodic = episodes
        .filter(
          (episode) =>
            episode.status === "active" &&
            episode.rootRefs.some((ref) => sameRef(ref, input.rootRef)),
        )
        .map((episode) =>
          SkillSourceSnapshotSchema.parse({
            ref: { kind: "episodic", id: episode.id, revision: episode.revision },
            rootRef: input.rootRef,
            conversationRef: episode.conversationRef,
            sourceExecutionIds: episode.sourceExecutionIds,
            producerRefs: episode.producerRefs,
            title: episode.goal.text,
            body: [
              episode.summary.text,
              `Outcome: ${episode.outcome.status}: ${episode.outcome.summary}`,
              ...episode.attempts.map((attempt) =>
                [attempt.description, attempt.result].filter(Boolean).join(" — "),
              ),
              ...episode.failuresAndRecoveries.map((item) =>
                [item.failure, item.recovery].filter(Boolean).join(" → "),
              ),
            ].join("\n"),
            outcome: episode.outcome.status,
            hasSuccessfulRecovery: episode.failuresAndRecoveries.some(
              (item) => item.recovery !== undefined,
            ),
            observedAt: episode.updatedAt,
            verified: false,
            valueScore: episode.valueScore,
            visibility: episode.visibility,
            sensitivity: episode.sensitivity,
          }),
        );
      const timestamp = input.now.toISOString();
      const semantic = facts
        .filter(
          (fact) =>
            fact.status === "active" &&
            fact.conflictsWith.length === 0 &&
            (fact.expiresAt === undefined || fact.expiresAt > timestamp) &&
            fact.rootRefs.some((ref) => sameRef(ref, input.rootRef)),
        )
        .map((fact) =>
          SkillSourceSnapshotSchema.parse({
            ref: { kind: "semantic", id: fact.id, revision: fact.revision },
            rootRef: input.rootRef,
            producerRefs: fact.producerRefs,
            title: `${fact.predicate}: ${fact.normalizedValue}`,
            body: fact.statement,
            outcome: "supporting",
            hasSuccessfulRecovery: false,
            observedAt: fact.observedAt,
            verified: fact.verifiedAt !== undefined,
            visibility: fact.visibility,
            sensitivity: fact.sensitivity,
          }),
        );
      const sortByObservedAt = (left: SkillSourceSnapshot, right: SkillSourceSnapshot): number =>
        right.observedAt.localeCompare(left.observedAt) ||
        sourceKey(left).localeCompare(sourceKey(right));

      // Episodic sources are the authority for the Skill evidence threshold.
      // Keep them ahead of Semantic context before applying the shared limit so
      // supporting facts cannot crowd out the evidence that makes extraction possible.
      return [...episodic.toSorted(sortByObservedAt), ...semantic.toSorted(sortByObservedAt)].slice(
        0,
        input.limit,
      );
    },
  };
}

function sameRef(left: MemorySubjectRef, right: MemorySubjectRef): boolean {
  return left.type === right.type && left.id === right.id;
}

function sourceKey(source: SkillSourceSnapshot): string {
  return `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`;
}
