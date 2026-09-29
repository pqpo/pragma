import { createHash } from "node:crypto";
import { defaultRuntimeTokenCounter, type RuntimeTokenCounter } from "@pragma/core";
import type { SemanticFact } from "@pragma/shared";
import type { EpisodicMemoryRecord } from "../episodic/schema.ts";
export type RetrievalRecord =
  | { module: "episodic"; record: EpisodicMemoryRecord }
  | { module: "semantic"; record: SemanticFact };
export interface MemorySegment {
  readonly segmentId: string;
  readonly fieldPath: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly textHash: string;
}
export function projectionHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function memoryProjectionFields(
  source: RetrievalRecord,
): Array<{ path: string; text: string }> {
  const fields: Array<{ path: string; text: string; prefix: string }> = [];
  const r = source.record;
  if (source.module === "episodic") {
    const episode = source.record;
    fields.push({
      path: "overview",
      text: `Goal: ${episode.goal.text}\nSummary: ${episode.summary.text}\nOutcome: ${episode.outcome.summary}`,
      prefix: "",
    });
    episode.attempts.forEach((item, i) =>
      fields.push({
        path: `attempts[${i}]`,
        text: `Attempt: ${item.description}\nResult: ${item.result ?? "Not recorded"}`,
        prefix: `Goal: ${episode.goal.text}\n`,
      }),
    );
    episode.failuresAndRecoveries.forEach((item, i) =>
      fields.push({
        path: `failuresAndRecoveries[${i}]`,
        text: `Failure: ${item.failure}\nRecovery: ${item.recovery ?? "Not recorded"}`,
        prefix: `Goal: ${episode.goal.text}\n`,
      }),
    );
  } else
    fields.push({
      path: "fact",
      text: `Statement: ${source.record.statement}\nPredicate: ${source.record.predicate}\nValue: ${source.record.normalizedValue}`,
      prefix: "",
    });
  if (r.status !== "active" || r.sensitivity === "restricted") return [];
  return fields.map((field) => ({
    path: field.path,
    text: redactMemoryProjection(field.prefix + field.text),
  }));
}
export function redactMemoryProjection(text: string): string {
  return text
    .replace(/(?:Bearer\s+)[\w.\-/+=]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[\w-]+/g, "[REDACTED]")
    .replace(
      /\b(?:api[_-]?key|password|secret|token)["']?\s*[:=]\s*["']?[^\s"',;}]+/gi,
      "credential=[REDACTED]",
    );
}
export function selectedMemoryText(
  source: RetrievalRecord,
  path: string,
  start: number,
  end: number,
): string | undefined {
  const field = memoryProjectionFields(source).find((field) => field.path === path);
  return field === undefined ? undefined : Array.from(field.text).slice(start, end).join("");
}
export function projectMemory(
  source: RetrievalRecord,
  maxTokens: number,
  counter: RuntimeTokenCounter = defaultRuntimeTokenCounter,
): MemorySegment[] {
  const result: MemorySegment[] = [];
  for (const field of memoryProjectionFields(source)) {
    const points = Array.from(field.text);
    let start = 0;
    while (start < points.length) {
      let lo = start + 1,
        hi = points.length,
        end = start;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (counter.countText(points.slice(start, mid).join("")).tokens <= maxTokens) {
          end = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (end === start) throw new Error("embedding_input_limit_too_small");
      // Prefer a sentence/paragraph boundary without dropping the rest of the field.
      if (end < points.length) {
        for (let i = end; i > start + (end - start) / 2; i--)
          if (/[\n.!?。！？]/u.test(points[i - 1]!)) {
            end = i;
            break;
          }
      }
      const text = points.slice(start, end).join("");
      result.push({
        segmentId: `${field.path}:${start}:${end}`,
        fieldPath: field.path,
        start,
        end,
        text,
        textHash: projectionHash(text),
      });
      start = end;
    }
  }
  return result;
}
