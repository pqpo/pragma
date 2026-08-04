import type { MemoryEvidenceEnvelope } from "@pragma/shared";
import { z } from "zod";

export const MemoryEvidenceOmissionStatsSchema = z.object({
  records: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  byTopic: z.record(z.string(), z.number().int().nonnegative()),
  firstOccurredAt: z.string().datetime().optional(),
  lastOccurredAt: z.string().datetime().optional(),
});

export type MemoryEvidenceOmissionStats = z.infer<typeof MemoryEvidenceOmissionStatsSchema>;

export interface BoundedEvidenceSelection {
  readonly retained: readonly MemoryEvidenceEnvelope[];
  readonly omitted: readonly MemoryEvidenceEnvelope[];
  readonly omittedStats: MemoryEvidenceOmissionStats;
}

export function selectBoundedMemoryEvidence(
  evidence: readonly MemoryEvidenceEnvelope[],
  limits: { readonly maxRecords: number; readonly maxBytes: number },
): BoundedEvidenceSelection {
  const ordered = evidence.toSorted(compareChronological);
  const firstUserId = ordered.find(isUserMessage)?.messageId;
  const latestUserId = ordered.findLast(isUserMessage)?.messageId;
  const latestAssistantId = ordered.findLast(isAssistantMessage)?.messageId;
  const completedTools = new Set(
    ordered
      .filter(
        (item) =>
          item.topic === "execution.tool.completed" || item.topic === "execution.tool.failed",
      )
      .map(toolCallId)
      .filter((value): value is string => value !== undefined),
  );
  const candidates = ordered
    .filter(
      (item) =>
        item.topic !== "execution.tool.started" ||
        toolCallId(item) === undefined ||
        !completedTools.has(toolCallId(item)!),
    )
    .map((item) => ({
      item,
      bytes: evidenceBytes(item),
      priority: evidencePriority(item, { firstUserId, latestUserId, latestAssistantId }),
    }))
    .toSorted(
      (left, right) =>
        right.priority - left.priority ||
        right.item.occurredAt.localeCompare(left.item.occurredAt) ||
        right.item.messageId.localeCompare(left.item.messageId),
    );
  const retained = new Set<string>();
  let retainedBytes = 0;
  for (const candidate of candidates) {
    if (retained.size >= limits.maxRecords) continue;
    if (retainedBytes + candidate.bytes > limits.maxBytes) continue;
    retained.add(candidate.item.messageId);
    retainedBytes += candidate.bytes;
  }
  const retainedItems = ordered.filter((item) => retained.has(item.messageId));
  const omitted = ordered.filter((item) => !retained.has(item.messageId));
  return { retained: retainedItems, omitted, omittedStats: omissionStats(omitted) };
}

export function mergeMemoryEvidenceOmissionStats(
  left: MemoryEvidenceOmissionStats,
  right: MemoryEvidenceOmissionStats,
): MemoryEvidenceOmissionStats {
  const byTopic: Record<string, number> = { ...left.byTopic };
  for (const [topic, count] of Object.entries(right.byTopic)) {
    byTopic[topic] = (byTopic[topic] ?? 0) + count;
  }
  return {
    records: left.records + right.records,
    bytes: left.bytes + right.bytes,
    byTopic,
    ...optionalRange("firstOccurredAt", [left.firstOccurredAt, right.firstOccurredAt], "first"),
    ...optionalRange("lastOccurredAt", [left.lastOccurredAt, right.lastOccurredAt], "last"),
  };
}

export const EMPTY_MEMORY_EVIDENCE_OMISSION_STATS: MemoryEvidenceOmissionStats = Object.freeze({
  records: 0,
  bytes: 0,
  byTopic: {},
});

function evidencePriority(
  item: MemoryEvidenceEnvelope,
  special: {
    readonly firstUserId?: string | undefined;
    readonly latestUserId?: string | undefined;
    readonly latestAssistantId?: string | undefined;
  },
): number {
  if (item.topic === "execution.execution.terminal") return 1_000;
  if (item.messageId === special.firstUserId) return 950;
  if (item.messageId === special.latestUserId) return 940;
  if (item.messageId === special.latestAssistantId) return 930;
  if (item.topic === "execution.tool.failed" || isFailedToolMessage(item)) return 900;
  if (item.topic.startsWith("artifact.")) return 850;
  if (isSummary(item)) return 800;
  if (isUserMessage(item)) return 700;
  if (isAssistantMessage(item)) return 650;
  if (item.topic === "execution.invocation.terminal") return 600;
  if (item.topic === "execution.tool.completed") return 300;
  if (item.topic === "execution.tool.started") return 100;
  return 500;
}

function omissionStats(evidence: readonly MemoryEvidenceEnvelope[]): MemoryEvidenceOmissionStats {
  const byTopic: Record<string, number> = {};
  let bytes = 0;
  for (const item of evidence) {
    byTopic[item.topic] = (byTopic[item.topic] ?? 0) + 1;
    bytes += evidenceBytes(item);
  }
  return {
    records: evidence.length,
    bytes,
    byTopic,
    ...(evidence[0] === undefined ? {} : { firstOccurredAt: evidence[0].occurredAt }),
    ...(evidence.at(-1) === undefined ? {} : { lastOccurredAt: evidence.at(-1)!.occurredAt }),
  };
}

function evidenceBytes(item: MemoryEvidenceEnvelope): number {
  return Buffer.byteLength(JSON.stringify(item));
}

function isUserMessage(item: MemoryEvidenceEnvelope): boolean {
  return messageRole(item) === "user";
}

function isAssistantMessage(item: MemoryEvidenceEnvelope): boolean {
  return messageRole(item) === "assistant";
}

function isSummary(item: MemoryEvidenceEnvelope): boolean {
  return messageRole(item) === "summary";
}

function isFailedToolMessage(item: MemoryEvidenceEnvelope): boolean {
  return messageRole(item) === "tool" && messagePayload(item)?.["status"] === "failed";
}

function messageRole(item: MemoryEvidenceEnvelope): unknown {
  return messagePayload(item)?.["role"];
}

function messagePayload(item: MemoryEvidenceEnvelope): Record<string, unknown> | undefined {
  if (typeof item.payload !== "object" || item.payload === null) return undefined;
  const message = (item.payload as Record<string, unknown>)["message"];
  return typeof message === "object" && message !== null
    ? (message as Record<string, unknown>)
    : undefined;
}

function toolCallId(item: MemoryEvidenceEnvelope): string | undefined {
  if (typeof item.payload !== "object" || item.payload === null) return undefined;
  const value = (item.payload as Record<string, unknown>)["toolCallId"];
  return typeof value === "string" ? value : undefined;
}

function compareChronological(left: MemoryEvidenceEnvelope, right: MemoryEvidenceEnvelope): number {
  return (
    left.occurredAt.localeCompare(right.occurredAt) || left.messageId.localeCompare(right.messageId)
  );
}

function optionalRange(
  key: "firstOccurredAt" | "lastOccurredAt",
  values: readonly (string | undefined)[],
  end: "first" | "last",
): Partial<Record<typeof key, string>> {
  const sorted = values.filter((value): value is string => value !== undefined).toSorted();
  const value = end === "first" ? sorted[0] : sorted.at(-1);
  return value === undefined ? {} : { [key]: value };
}
