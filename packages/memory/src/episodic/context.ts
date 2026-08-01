import {
  StaticContextStore,
  type ExpertAgentContextStore,
  type ExpertAgentContextItemSeed,
} from "@pragma/core";
import type { MemoryEvidenceEnvelope } from "@pragma/shared";

import type { EpisodicMemoryRecord } from "./schema.ts";
import type { EpisodicMemoryStore } from "./store.ts";

export function createEpisodicMemoryContextProvider(
  store: EpisodicMemoryStore,
): ExpertAgentContextStore {
  const rootStore = async (): Promise<StaticContextStore> => {
    const [episodes, diagnostic] = await Promise.all([store.list(), store.inspect()]);
    const seeds: ExpertAgentContextItemSeed[] = [
      {
        id: "summary.md",
        content: renderSummary(episodes, diagnostic),
        metadata: metadata(
          "Current Episodic Memory coverage and recent outcomes.",
          "model_decision",
          "high",
        ),
      },
      {
        id: "index.md",
        content: renderIndex(episodes),
        metadata: metadata(
          "Searchable Episodic Memory index. Read an item for the full historical precedent.",
          "model_decision",
          "normal",
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
        const episode = await store.get(episodeId);
        return await new StaticContextStore(
          episode === undefined ? [] : [episodeSeed(episode)],
        ).readContext(input);
      }
      const evidenceId = readPathId(input.id, "evidence/");
      if (evidenceId !== undefined) {
        const evidence = await store.getEvidence(evidenceId);
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
      const episodes = await store.search(input.query, remaining);
      const detailResult = await new StaticContextStore(episodes.map(episodeSeed)).searchContext({
        ...input,
        maxResults: remaining,
      });
      return detailResult.ok
        ? { ...detailResult, value: [...rootResult.value, ...detailResult.value] }
        : detailResult;
    },
    addContext: async (input) => await new StaticContextStore().addContext(input),
    editContext: async (input) => await new StaticContextStore().editContext(input),
    deleteContext: async (input) => await new StaticContextStore().deleteContext(input),
  };
}

function episodeSeed(episode: EpisodicMemoryRecord): ExpertAgentContextItemSeed {
  return {
    id: `items/${episode.id}.md`,
    content: renderEpisode(episode),
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
  diagnostic: Awaited<ReturnType<EpisodicMemoryStore["inspect"]>>,
): string {
  const active = episodes.filter((episode) => episode.status === "active");
  const succeeded = active.filter((episode) => episode.outcome.status === "succeeded").length;
  const failed = active.filter((episode) => episode.outcome.status === "failed").length;
  return [
    "# Episodic Memory Summary",
    "",
    "Episodic Memory records historical precedent. It does not establish current truth.",
    "",
    `- Active episodes: ${active.length}`,
    `- Successful outcomes: ${succeeded}`,
    `- Failed outcomes: ${failed}`,
    `- Pending extraction jobs: ${diagnostic.pending + diagnostic.running}`,
    `- Jobs needing attention: ${diagnostic.needsAttention}`,
    `- Low-value tasks rejected: ${diagnostic.rejectedLowValue}`,
    "",
    "## Recent high-value precedents",
    ...active
      .toSorted(compareEpisode)
      .slice(0, 5)
      .map(
        (episode) =>
          `- ${episode.id} — ${episode.outcome.status} — ${oneLine(episode.summary.text, 180)}`,
      ),
    "",
  ].join("\n");
}

function renderIndex(episodes: readonly EpisodicMemoryRecord[]): string {
  return [
    "# Episodic Memory Index",
    "",
    "Search this index when looking for prior attempts, failures, recoveries, or outcomes.",
    "",
    ...episodes
      .filter((episode) => episode.status === "active")
      .toSorted(compareEpisode)
      .map(
        (episode) =>
          `- ${episode.id} | ${episode.updatedAt} | ${episode.language} | ${episode.outcome.status} | value ${episode.valueScore.toFixed(2)} | ${oneLine(episode.summary.text, 220)}`,
      ),
    "",
  ].join("\n");
}

function renderEpisode(episode: EpisodicMemoryRecord): string {
  return [
    `# Episode ${episode.id}`,
    "",
    `- Execution: ${episode.executionId}`,
    `- Terminal Evidence: ${episode.terminalMessageId}`,
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
          `${attempt.description}${attempt.result === undefined ? "" : ` — ${attempt.result}`} [${attempt.evidenceRefs.join(", ")}]`,
      ),
      "No material attempts were extracted.",
    ),
    "",
    "## Failures and recoveries",
    ...bullets(
      episode.failuresAndRecoveries.map(
        (item) =>
          `${item.failure}${item.recovery === undefined ? "" : ` Recovery: ${item.recovery}`} [${item.evidenceRefs.join(", ")}]`,
      ),
      "No material failure or recovery was extracted.",
    ),
    "",
    "## Outcome",
    `${episode.outcome.summary} [${episode.outcome.evidenceRefs.join(", ")}]`,
    "",
    "## Evidence",
    ...episode.evidenceRefs.map((id) => `- evidence/${id}.md`),
    "",
    "Evidence is a separate verification layer. Read it only when the conclusion needs checking.",
    "",
  ].join("\n");
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

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function bullets(values: readonly string[], empty: string): readonly string[] {
  return values.length === 0 ? [`- ${empty}`] : values.map((value) => `- ${value}`);
}
