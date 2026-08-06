import {
  KnowledgeSourceSnapshotSchema,
  type KnowledgeSourceSnapshot,
  type MemorySubjectRef,
} from "@pragma/shared";

import type { KnowledgeSourceReader } from "./schema.ts";
import type { EpisodicMemoryStore } from "../episodic/store.ts";
import type { SemanticMemoryStore } from "../semantic/store.ts";

/**
 * Federates read-only snapshots from source Modules. Knowledge never receives a
 * write-capable cross-Module port.
 */
export function createKnowledgeSourceReader(options: {
  readonly episodic: Pick<EpisodicMemoryStore, "list">;
  readonly semantic: Pick<SemanticMemoryStore, "list" | "sourceExecutionIds">;
}): KnowledgeSourceReader {
  return {
    async listEligibleSources(input) {
      const [episodes, facts] = await Promise.all([
        options.episodic.list(),
        options.semantic.list(),
      ]);
      const episodicSources = episodes
        .filter(
          (episode) =>
            episode.status === "active" &&
            episode.valueScore >= 0.85 &&
            episode.rootRefs.some((ref) => sameRef(ref, input.rootRef)),
        )
        .map((episode) =>
          KnowledgeSourceSnapshotSchema.parse({
            ref: { kind: "episodic", id: episode.id, revision: episode.revision },
            rootRef: input.rootRef,
            producerRefs: episode.producerRefs,
            sourceExecutionIds: episode.sourceExecutionIds.slice(0, 100),
            title: episode.goal.text,
            body: [
              episode.summary.text,
              episode.outcome.summary,
              ...episode.attempts.map((attempt) => attempt.description),
              ...episode.failuresAndRecoveries.flatMap((item) => [
                item.failure,
                ...(item.recovery === undefined ? [] : [item.recovery]),
              ]),
            ].join("\n"),
            observedAt: episode.updatedAt,
            verified: false,
            valueScore: episode.valueScore,
            visibility: episode.visibility,
            sensitivity: episode.sensitivity,
          }),
        );
      const timestamp = input.now.toISOString();
      const semanticSources = await Promise.all(
        facts
          .filter(
            (fact) =>
              fact.status === "active" &&
              fact.conflictsWith.length === 0 &&
              (fact.expiresAt === undefined || fact.expiresAt > timestamp) &&
              fact.rootRefs.some((ref) => sameRef(ref, input.rootRef)),
          )
          .map(async (fact) =>
            KnowledgeSourceSnapshotSchema.parse({
              ref: { kind: "semantic", id: fact.id, revision: fact.revision },
              rootRef: input.rootRef,
              producerRefs: fact.producerRefs,
              sourceExecutionIds: await options.semantic.sourceExecutionIds(fact.id),
              title: `${fact.predicate}: ${fact.normalizedValue}`,
              body: fact.statement,
              observedAt: fact.observedAt,
              verified: fact.verifiedAt !== undefined,
              visibility: fact.visibility,
              sensitivity: fact.sensitivity,
            }),
          ),
      );
      return [...episodicSources, ...semanticSources].toSorted(compareSource).slice(0, input.limit);
    },
  };
}

function compareSource(left: KnowledgeSourceSnapshot, right: KnowledgeSourceSnapshot): number {
  return (
    right.observedAt.localeCompare(left.observedAt) ||
    sourceKey(left).localeCompare(sourceKey(right))
  );
}

function sourceKey(source: KnowledgeSourceSnapshot): string {
  return `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`;
}

function sameRef(left: MemorySubjectRef, right: MemorySubjectRef): boolean {
  return left.type === right.type && left.id === right.id;
}
