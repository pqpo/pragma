import { defaultRuntimeTokenCounter } from "@pragma/core";
import { extractionBudget } from "./budget.ts";
import { allRead, evidenceText, readProgress } from "./evidence.ts";
import {
  MemoryExtractionFeedbackSchema,
  type MemoryExtractionFeedbackInput,
} from "./contract-v2.ts";
import {
  fail,
  MEMORY_EXTRACTION_LIMITS,
  type SessionState,
  type MemoryExtractionType,
} from "./schema.ts";

export const CONTROL_RESERVE_TOKENS = 1024;
export function requestedTypes(state: SessionState): MemoryExtractionType[] {
  return "targets" in state.input
    ? state.input.targets
    : state.module === "conversation"
      ? []
      : [state.module];
}
export function extractionProgress(
  state: SessionState,
  callLimit = extractionBudget(state.input).calls,
) {
  const requested = requestedTypes(state);
  return {
    requestedTypes: requested,
    completedTypes: requested.filter((type) => state.results[type] !== undefined),
    unreadRecords: state.input.evidence.filter(
      (item, index) =>
        state.contextTypes.some(
          (type) =>
            !("evidenceTypes" in state.input) ||
            state.input.evidenceTypes[item.messageId]?.includes(type),
        ) && readProgress(state, `e${index + 1}`) < evidenceText(item).text.length,
    ).length,
    stagedFacts: state.results.semantic === undefined ? Object.keys(state.candidates).length : 0,
    stagedEpisodeParts: state.results.episodic === undefined ? Object.keys(state.parts).length : 0,
    missingEpisodeParts:
      requested.includes("episodic") && state.results.episodic === undefined
        ? (["goal", "summary", "outcome"] as const).filter(
            (part) => state.parts[part] === undefined,
          )
        : [],
    remainingCalls: Math.max(0, callLimit - state.calls),
    remainingTokens: Math.max(0, state.tokenLimit - state.deliveredTokens),
  };
}
export function formatExtractionFeedback(
  state: SessionState,
  body: string,
  feedback: MemoryExtractionFeedbackInput & { candidate?: string },
  control: boolean,
  callLimit = extractionBudget(state.input).calls,
): string {
  // The reserve can save already-supported staged work without another source read or admission.
  // Revocation failures remain blocked and never gain progress through this path.
  if (
    feedback.code === "memory_curator_budget_exhausted" &&
    feedback.status === "needs_correction"
  ) {
    const ready = requestedTypes(state).find(
      (type) =>
        state.contextTypes.includes(type) &&
        state.results[type] === undefined &&
        allRead(state, type) &&
        (type === "semantic"
          ? Object.keys(state.candidates).length > 0
          : ["goal", "summary", "outcome"].every((part) => state.parts[part] !== undefined)),
    );
    feedback =
      ready === "semantic"
        ? { ...feedback, nextCall: { tool: "finish_semantic_extraction", args: {} } }
        : ready === "episodic"
          ? { ...feedback, requiredFields: ["language", "valueScore"] }
          : { ...feedback, status: "blocked" };
  }
  const metadata = MemoryExtractionFeedbackSchema.parse({
    schemaVersion: "pragma.memory-curator-tool-result/v2",
    ...feedback,
    ...(feedback.status === "blocked" ? {} : { progress: extractionProgress(state, callLimit) }),
  });
  let text = "";
  let tokens = 0;
  for (let iteration = 0; iteration < 6; iteration++) {
    if (metadata.progress !== undefined)
      metadata.progress.remainingTokens = Math.max(
        0,
        state.tokenLimit - state.deliveredTokens - tokens,
      );
    text = `Feedback: ${JSON.stringify(metadata)}\n\n${body}`;
    const next = defaultRuntimeTokenCounter.countText(text).tokens;
    if (next === tokens) break;
    tokens = next;
  }
  tokens = defaultRuntimeTokenCounter.countText(text).tokens;
  if (
    tokens > MEMORY_EXTRACTION_LIMITS.responseTokens ||
    state.deliveredTokens + tokens > state.tokenLimit - (control ? 0 : CONTROL_RESERVE_TOKENS)
  )
    fail("memory_curator_budget_exhausted");
  state.deliveredTokens += tokens;
  return text;
}
