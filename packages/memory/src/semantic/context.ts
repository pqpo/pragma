import {
  StaticContextStore,
  type ExpertAgentContextItemSeed,
  type ExpertAgentContextStore,
} from "@pragma/core";
import type { MemoryEvidenceEnvelope, SemanticFact } from "@pragma/shared";

import type { SemanticMemoryStore } from "./store.ts";
import { escapeMarkdownLinkLabel } from "../context/markdown.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";
import { trimUtf8ToByteLimit } from "../storage/utf8.ts";

const SUMMARY_MAX_BYTES = 4_096;

export function createSemanticMemoryContextProvider(
  store: SemanticMemoryStore,
  scope: MemoryRecallScope,
  now: () => Date,
): ExpertAgentContextStore {
  const rootStore = async (): Promise<StaticContextStore> => {
    const timestamp = now();
    const facts = await store.listForRecall(scope, timestamp);
    return new StaticContextStore([
      {
        id: "summary.md",
        content: renderSummary(facts, timestamp),
        metadata: metadata(
          "Current effective facts, confidence, conflicts, and review state.",
          "model_decision",
          "high",
        ),
      },
      {
        id: "index.md",
        content: trimUtf8ToByteLimit(renderIndex(facts), 4_096),
        metadata: metadata(
          "Searchable Semantic Memory index. Read details before relying on a fact.",
          "model_decision",
          "normal",
        ),
      },
    ]);
  };

  return {
    listContext: async (input) => await (await rootStore()).listContext(input),
    async readContext(input) {
      if (input.id === "summary.md" || input.id === "index.md") {
        return await (await rootStore()).readContext(input);
      }
      const factId = readPathId(input.id, "items/");
      if (factId !== undefined) {
        const fact = await store.getForRecall(scope, factId, now());
        return await new StaticContextStore(fact === undefined ? [] : [factSeed(fact)]).readContext(
          input,
        );
      }
      const evidenceId = readPathId(input.id, "evidence/");
      if (evidenceId !== undefined) {
        const evidence = await store.getEvidenceForRecall(scope, evidenceId, now());
        return await new StaticContextStore(
          evidence === undefined ? [] : [evidenceSeed(evidence)],
        ).readContext(input);
      }
      return await new StaticContextStore().readContext(input);
    },
    async searchContext(input) {
      const root = await rootStore();
      const rootMatches = await root.searchContext(input);
      if (!rootMatches.ok) return rootMatches;
      const remaining = Math.max(0, (input.maxResults ?? 20) - rootMatches.value.length);
      if (remaining === 0) return rootMatches;
      const facts = await store.searchForRecall(scope, input.query, remaining, now());
      const details = await new StaticContextStore(facts.map(factSeed)).searchContext({
        ...input,
        maxResults: remaining,
      });
      return details.ok ? { ...details, value: [...rootMatches.value, ...details.value] } : details;
    },
    addContext: async (input) => await new StaticContextStore().addContext(input),
    editContext: async (input) => await new StaticContextStore().editContext(input),
    deleteContext: async (input) => await new StaticContextStore().deleteContext(input),
  };
}

function factSeed(fact: SemanticFact): ExpertAgentContextItemSeed {
  return {
    id: `items/${fact.id}.md`,
    revision: String(fact.revision),
    content: renderFact(fact),
    metadata: metadata(
      `Semantic fact: ${oneLine(fact.statement, 180)}`,
      "manual",
      fact.verifiedAt === undefined ? "normal" : "high",
      fact.sensitivity,
    ),
  };
}

function evidenceSeed(evidence: MemoryEvidenceEnvelope): ExpertAgentContextItemSeed {
  return {
    id: `evidence/${evidence.messageId}.md`,
    content: renderEvidence(evidence),
    metadata: metadata(
      "Supporting Evidence for a Semantic Memory fact.",
      "manual",
      "low",
      evidence.sensitivity,
    ),
  };
}

function renderSummary(facts: readonly SemanticFact[], now: Date): string {
  const verified = facts.filter((fact) => fact.verifiedAt !== undefined).length;
  const conflicting = facts.filter((fact) => fact.conflictsWith.length > 0).length;
  const dueForReview = facts.filter(
    (fact) => fact.reviewAt !== undefined && fact.reviewAt <= now.toISOString(),
  ).length;
  return fitLines(
    [
      "# Semantic Memory Summary",
      "",
      "Semantic Memory describes current beliefs. Conflicts and review dates are evidence to inspect, not instructions to hide.",
      "",
      `- Effective facts: ${facts.length}`,
      `- Verified facts: ${verified}`,
      `- Facts with conflicts: ${conflicting}`,
      `- Due for review: ${dueForReview}`,
      "",
      ...facts.map(renderIndexLine),
      ...(facts.length === 0 ? ["- No effective facts are available in this scope."] : []),
      "",
    ],
    SUMMARY_MAX_BYTES,
  );
}

function renderIndex(facts: readonly SemanticFact[]): string {
  return [
    "# Semantic Memory Index",
    "",
    "Read the fact detail when confidence, freshness, conflict, or provenance matters.",
    "",
    ...(facts.length === 0
      ? ["- No effective facts are available in this scope."]
      : facts.map(renderIndexLine)),
    "",
  ].join("\n");
}

function renderIndexLine(fact: SemanticFact): string {
  const flags = [
    fact.verifiedAt === undefined ? undefined : "verified",
    fact.conflictsWith.length === 0 ? undefined : `conflicts:${fact.conflictsWith.length}`,
    fact.reviewAt === undefined ? undefined : `review:${fact.reviewAt}`,
  ].filter((value): value is string => value !== undefined);
  const label = escapeMarkdownLinkLabel(oneLine(fact.statement, 180));
  return `- [${label}](semantic/items/${fact.id}.md) — confidence ${fact.confidence.toFixed(2)}${flags.length === 0 ? "" : ` | ${flags.join(", ")}`}`;
}

function renderFact(fact: SemanticFact): string {
  return [
    `# Fact ${fact.id}`,
    "",
    `- Revision: ${fact.revision}`,
    `- Subjects: ${fact.subjectRefs.map(refLabel).join(", ")}`,
    `- Predicate: ${fact.predicate}`,
    `- Normalized value: ${fact.normalizedValue}`,
    `- Confidence: ${fact.confidence.toFixed(2)}`,
    `- Observed: ${fact.observedAt}`,
    `- Verified: ${fact.verifiedAt ?? "no"}`,
    `- Review: ${fact.reviewAt ?? "not scheduled"}`,
    `- Expires: ${fact.expiresAt ?? "not scheduled"}`,
    `- Conflicts: ${
      fact.conflictsWith.length === 0
        ? "none"
        : fact.conflictsWith.map((id) => `[${oneLine(id, 80)}](semantic/items/${id}.md)`).join(", ")
    }`,
    "",
    "## Statement",
    fact.statement,
    "",
    "## Evidence",
    ...fact.evidenceRefs.map((id) => `- [Evidence ${oneLine(id, 80)}](semantic/evidence/${id}.md)`),
    "",
    ...(fact.conflictsWith.length === 0
      ? []
      : [
          "This fact conflicts with another active fact. Inspect both facts and their Evidence before choosing one.",
          "",
        ]),
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

function readPathId(path: string, prefix: "items/" | "evidence/"): string | undefined {
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return undefined;
  const id = path.slice(prefix.length, -3);
  return id.length === 0 || id.includes("/") ? undefined : id;
}

function metadata(
  description: string,
  trigger: "always_on" | "model_decision" | "manual",
  priority: "critical" | "high" | "normal" | "low",
  sensitivity: "public" | "internal" | "confidential" | "restricted" = "internal",
) {
  return { description, trigger, priority, trustLevel: "system" as const, sensitivity };
}

function refLabel(ref: { readonly type: string; readonly id: string }): string {
  return `${ref.type}:${ref.id}`;
}

function oneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
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
