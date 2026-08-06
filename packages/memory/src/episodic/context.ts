import {
  StaticContextStore,
  type ExpertAgentContextStore,
  type ExpertAgentContextItemSeed,
} from "@pragma/core";
import type { MemoryEvidenceEnvelope } from "@pragma/shared";

import type { EpisodicMemoryRecord } from "./schema.ts";
import type { EpisodicMemoryStore } from "./store.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";

const SUMMARY_MAX_BYTES = 1_024;

export function createEpisodicMemoryContextProvider(
  store: EpisodicMemoryStore,
  scope: MemoryRecallScope,
): ExpertAgentContextStore {
  const rootStore = async (): Promise<StaticContextStore> => {
    const episodes = await store.listForRecall(scope);
    const seeds: ExpertAgentContextItemSeed[] = [
      {
        id: "summary.md",
        content: renderSummary(episodes, scope),
        metadata: metadata(
          "The three most recent historical Episodes. Recall more only when prior experience matters.",
          "model_decision",
          "normal",
        ),
      },
      {
        id: "index.md",
        content: renderIndex(episodes, scope),
        metadata: metadata(
          "Searchable Episodic Memory index. Read an item for the full historical precedent.",
          "model_decision",
          "low",
        ),
      },
    ];
    return new StaticContextStore(seeds);
  };

  return {
    listContext: async (input) => await (await rootStore()).listContext(input),
    async readContext(input) {
      if (input.id === "summary.md" || input.id === "index.md") {
        return await (await rootStore()).readContext(input);
      }
      const episodeId = readPathId(input.id, "items/");
      if (episodeId !== undefined) {
        const episode = await store.getForRecall(scope, episodeId);
        return await new StaticContextStore(
          episode === undefined ? [] : [episodeSeed(episode, scope)],
        ).readContext(input);
      }
      const evidenceId = readPathId(input.id, "evidence/");
      if (evidenceId !== undefined) {
        const evidence = await store.getEvidenceForRecall(scope, evidenceId);
        return await new StaticContextStore(
          evidence === undefined ? [] : [evidenceSeed(evidence)],
        ).readContext(input);
      }
      return await new StaticContextStore().readContext(input);
    },
    async searchContext(input) {
      const root = await rootStore();
      const rootResult = await root.searchContext(input);
      if (!rootResult.ok) return rootResult;
      const remaining = Math.max(0, (input.maxResults ?? 20) - rootResult.value.length);
      if (remaining === 0) return rootResult;
      const episodes = await store.searchForRecall(scope, input.query, remaining);
      const detailResult = await new StaticContextStore(
        episodes.map((episode) => episodeSeed(episode, scope)),
      ).searchContext({ ...input, maxResults: remaining });
      return detailResult.ok
        ? {
            ...detailResult,
            value: [
              ...rootResult.value,
              ...detailResult.value.map((match) => {
                const episode = episodes.find(
                  (candidate) => match.id === `items/${candidate.id}.md`,
                );
                return episode === undefined
                  ? match
                  : { ...match, line: `[${viewLabel(episode, scope)}] ${match.line}` };
              }),
            ],
          }
        : detailResult;
    },
    addContext: async (input) => await new StaticContextStore().addContext(input),
    editContext: async (input) => await new StaticContextStore().editContext(input),
    deleteContext: async (input) => await new StaticContextStore().deleteContext(input),
  };
}

function episodeSeed(
  episode: EpisodicMemoryRecord,
  scope: MemoryRecallScope,
): ExpertAgentContextItemSeed {
  return {
    id: `items/${episode.id}.md`,
    content: renderEpisode(episode, scope),
    revision: String(episode.revision),
    metadata: metadata(
      `Historical episode: ${oneLine(episode.summary.text, 180)}`,
      "manual",
      "normal",
      episode.sensitivity,
    ),
  };
}

function evidenceSeed(evidence: MemoryEvidenceEnvelope): ExpertAgentContextItemSeed {
  return {
    id: `evidence/${evidence.messageId}.md`,
    content: renderEvidence(evidence),
    metadata: metadata(
      "Supporting Evidence for an Episodic Memory record.",
      "manual",
      "low",
      evidence.sensitivity,
    ),
  };
}

function readPathId(path: string, prefix: "items/" | "evidence/"): string | undefined {
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return undefined;
  const id = path.slice(prefix.length, -3);
  return id.length === 0 || id.includes("/") ? undefined : id;
}

function renderSummary(
  episodes: readonly EpisodicMemoryRecord[],
  scope: MemoryRecallScope,
): string {
  const active = episodes.filter((episode) => episode.status === "active");
  const succeeded = active.filter((episode) => episode.outcome.status === "succeeded").length;
  const failed = active.filter((episode) => episode.outcome.status === "failed").length;
  const recent = active.toSorted(compareEpisodeRecency).slice(0, 3);
  return fitLines(
    [
      "# Episodic Memory Summary",
      "",
      "Historical precedent only; search when prior experience is relevant.",
      "",
      `- Active: ${active.length}; succeeded: ${succeeded}; failed: ${failed}`,
      "",
      "## Three most recent",
      ...(recent.length === 0
        ? ["- No episodes are available in this scope."]
        : recent.map(
            (episode) =>
              `- [${oneLine(episode.goal.text, 60)}](episodic/items/${episode.id}.md) — ${viewLabel(episode, scope)} — ${episode.updatedAt} — ${episode.outcome.status}`,
          )),
      "",
    ],
    SUMMARY_MAX_BYTES,
  );
}

function renderIndex(episodes: readonly EpisodicMemoryRecord[], scope: MemoryRecallScope): string {
  const groups = groupEpisodes(episodes, scope);
  return [
    "# Episodic Memory Index",
    "",
    "Search this index when looking for prior attempts, failures, recoveries, or outcomes.",
    "",
    ...renderIndexGroup("Current asset experience", groups.currentAsset, "current-asset"),
    ...(sameRef(scope.rootRef, scope.expertRef)
      ? []
      : renderIndexGroup("Current expert personal experience", groups.personal, "personal")),
    "",
  ].join("\n");
}

function renderEpisode(episode: EpisodicMemoryRecord, scope: MemoryRecallScope): string {
  return [
    `# Episode ${episode.id}`,
    "",
    `- Execution: ${episode.executionId}`,
    `- Terminal Evidence: ${episode.terminalMessageId}`,
    `- Memory scope: ${viewLabel(episode, scope)}`,
    `- Owned by: ${episode.rootRefs.map(refLabel).join(", ")}`,
    `- Producers: ${episode.producerRefs.map(refLabel).join(", ") || "unknown"}`,
    `- Outcome: ${episode.outcome.status}`,
    `- Language: ${episode.language}`,
    `- Value: ${episode.valueScore.toFixed(2)}`,
    `- Revision: ${episode.revision}`,
    `- Updated: ${episode.updatedAt}`,
    "",
    "## Goal",
    episode.goal.text,
    "",
    "## Summary",
    episode.summary.text,
    "",
    "## Attempts",
    ...bullets(
      episode.attempts.map(
        (attempt) =>
          `${attempt.description}${attempt.result === undefined ? "" : ` — ${attempt.result}`}`,
      ),
      "No material attempts were extracted.",
    ),
    "",
    "## Failures and recoveries",
    ...bullets(
      episode.failuresAndRecoveries.map(
        (item) =>
          `${item.failure}${item.recovery === undefined ? "" : ` Recovery: ${item.recovery}`}`,
      ),
      "No material failure or recovery was extracted.",
    ),
    "",
    "## Outcome",
    episode.outcome.summary,
    "",
    "## Evidence",
    ...episode.evidenceRefs.map(
      (id) => `- [Evidence ${oneLine(id, 80)}](episodic/evidence/${id}.md)`,
    ),
    "",
    "Evidence is a separate verification layer. Read it only when the conclusion needs checking.",
    "",
  ].join("\n");
}

function groupEpisodes(episodes: readonly EpisodicMemoryRecord[], scope: MemoryRecallScope) {
  return {
    currentAsset: episodes.filter((episode) => hasRef(episode.rootRefs, scope.rootRef)),
    personal: sameRef(scope.rootRef, scope.expertRef)
      ? []
      : episodes.filter((episode) => hasRef(episode.rootRefs, scope.expertRef)),
  };
}

function renderIndexGroup(
  title: string,
  episodes: readonly EpisodicMemoryRecord[],
  label: "current-asset" | "personal",
): readonly string[] {
  return [
    `## ${title}`,
    ...(episodes.length === 0
      ? ["- No episodes are available in this scope."]
      : episodes
          .toSorted(compareEpisode)
          .map(
            (episode) =>
              `- [${oneLine(episode.goal.text, 120)}](episodic/items/${episode.id}.md) — ${label} | ${episode.updatedAt} | ${episode.outcome.status} | value ${episode.valueScore.toFixed(2)} | ${oneLine(episode.summary.text, 180)}`,
          )),
    "",
  ];
}

function viewLabel(episode: EpisodicMemoryRecord, scope: MemoryRecallScope): string {
  return hasRef(episode.rootRefs, scope.rootRef) ? "current-asset" : "personal";
}

function hasRef(
  refs: readonly { readonly type: string; readonly id: string }[],
  expected: { readonly type: string; readonly id: string },
): boolean {
  return refs.some((ref) => sameRef(ref, expected));
}

function sameRef(
  left: { readonly type: string; readonly id: string },
  right: { readonly type: string; readonly id: string },
): boolean {
  return left.type === right.type && left.id === right.id;
}

function refLabel(ref: { readonly type: string; readonly id: string }): string {
  return `${ref.type}:${ref.id}`;
}

function renderEvidence(evidence: MemoryEvidenceEnvelope): string {
  return [
    `# Evidence ${evidence.messageId}`,
    "",
    `- Topic: ${evidence.topic}`,
    `- Schema: ${evidence.schemaRef}`,
    `- Occurred: ${evidence.occurredAt}`,
    `- Source: ${evidence.sourceRef.type}:${evidence.sourceRef.id}`,
    `- Sensitivity: ${evidence.sensitivity}`,
    "",
    "## Safe payload",
    "```json",
    JSON.stringify(evidence.payload, null, 2),
    "```",
    "",
  ].join("\n");
}

function metadata(
  description: string,
  trigger: "always_on" | "model_decision" | "manual",
  priority: "critical" | "high" | "normal" | "low",
  sensitivity: "public" | "internal" | "confidential" | "restricted" = "internal",
) {
  return { description, trigger, priority, trustLevel: "system" as const, sensitivity };
}

function compareEpisode(left: EpisodicMemoryRecord, right: EpisodicMemoryRecord): number {
  return right.valueScore - left.valueScore || right.updatedAt.localeCompare(left.updatedAt);
}

function compareEpisodeRecency(left: EpisodicMemoryRecord, right: EpisodicMemoryRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function bullets(values: readonly string[], empty: string): readonly string[] {
  return values.length === 0 ? [`- ${empty}`] : values.map((value) => `- ${value}`);
}

function fitLines(lines: readonly string[], maxBytes: number): string {
  const accepted: string[] = [];
  for (const line of lines) {
    const next = [...accepted, line].join("\n");
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    accepted.push(line);
  }
  return `${accepted.join("\n").trimEnd()}\n`;
}
