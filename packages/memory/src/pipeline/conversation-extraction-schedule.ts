import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";

/** Independent scheduling thresholds; existing durable deadlines are not rewritten on startup. */
export const CONVERSATION_EXTRACTION_DELAYS = Object.freeze({
  idleMs: DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
  completedMs: 10 * 60_000,
});

export function conversationExtractionEligibleAt(
  sourceUpdatedAt: string,
  activity?: { readonly state: "active" | "running" | "completed"; readonly updatedAt: string },
): string {
  const lastActivity = Math.max(
    Date.parse(sourceUpdatedAt),
    activity === undefined ? 0 : Date.parse(activity.updatedAt),
  );
  const delay =
    activity?.state === "completed"
      ? CONVERSATION_EXTRACTION_DELAYS.completedMs
      : CONVERSATION_EXTRACTION_DELAYS.idleMs;
  return new Date(lastActivity + delay).toISOString();
}
