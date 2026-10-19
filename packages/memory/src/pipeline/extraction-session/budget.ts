import { defaultRuntimeTokenCounter } from "@pragma/core";
import { evidenceText } from "./evidence.ts";
import { MEMORY_EXTRACTION_LIMITS, type MemoryExtractionInput } from "./schema.ts";

/** Allow one complete source traversal, plus bounded discovery and correction work. */
export function extractionBudget(input: MemoryExtractionInput): { tokens: number; calls: number } {
  const sourceTokens = input.evidence.reduce(
    (total, item, index) =>
      total +
      defaultRuntimeTokenCounter.countText(
        `[e${index + 1}] ${evidenceText(item).role} · ${item.occurredAt} · allowed types: episodic, semantic\n${evidenceText(item).text}`,
      ).tokens,
    0,
  );
  // Pages may end at paragraph boundaries; reserve space for cursors and headers too.
  const pages =
    Math.ceil(sourceTokens / 1000) +
    Math.ceil(input.evidence.length / MEMORY_EXTRACTION_LIMITS.pageSize);
  return {
    tokens: Math.min(
      MEMORY_EXTRACTION_LIMITS.maxDeliveredTokens,
      Math.max(MEMORY_EXTRACTION_LIMITS.deliveredTokens, sourceTokens + pages * 100 + 16000),
    ),
    calls: Math.max(MEMORY_EXTRACTION_LIMITS.calls, pages + MEMORY_EXTRACTION_LIMITS.calls),
  };
}
