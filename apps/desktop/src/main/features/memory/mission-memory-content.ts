import {
  memoryQueryDigest,
  memoryProjectionFields,
  projectionHash,
  redactMemoryProjection,
  selectedMemoryText,
  type MemoryRecallActivity,
  type RetrievalRecord,
} from "@pragma/memory";
import { ExpertAgentToolStartedEventSchema, type ExecutionEvent } from "@pragma/shared";
import type {
  DesktopMissionMemoryActivity,
  DesktopMissionMemoryAttentionContent,
  DesktopMissionMemoryRecallPage,
} from "../../../shared/contracts/index.ts";

export type MissionMemorySourceReader = (
  module: "episodic" | "semantic",
  id: string,
) => Promise<RetrievalRecord | undefined>;
type AttentionContext = NonNullable<DesktopMissionMemoryActivity["attention"]>[number];

async function readSource(
  sources: MissionMemorySourceReader,
  module: "episodic" | "semantic",
  id: string,
): Promise<RetrievalRecord | undefined> {
  const source = await sources(module, id);
  return source?.record.status === "active" && source.record.sensitivity !== "restricted"
    ? source
    : undefined;
}
function sourceTitle(source: RetrievalRecord): string {
  return Array.from(
    redactMemoryProjection(
      source.module === "episodic" ? source.record.goal.text : source.record.statement,
    ),
  )
    .slice(0, 180)
    .join("");
}

export async function nameMissionAttention(
  sources: MissionMemorySourceReader,
  contexts: readonly AttentionContext[],
): Promise<AttentionContext[]> {
  return Promise.all(
    contexts.map(async (context) => ({
      ...context,
      entries: await Promise.all(
        context.entries.map(async (entry) => {
          const source = await readSource(sources, entry.module, entry.memoryId);
          return {
            ...entry,
            ...(source === undefined || source.record.revision !== entry.revision
              ? {}
              : { title: sourceTitle(source) }),
          };
        }),
      ),
    })),
  );
}

export async function readMissionAttentionContent(
  sources: MissionMemorySourceReader,
  context: AttentionContext,
): Promise<DesktopMissionMemoryAttentionContent> {
  const entries = await Promise.all(
    context.entries.map(async (entry) => {
      const source = await readSource(sources, entry.module, entry.memoryId);
      if (source === undefined || source.record.revision !== entry.revision) return undefined;
      const snippets = entry.selectedPaths.map((path) => {
        const text = selectedMemoryText(source, path.fieldPath, path.start, path.end);
        return text !== undefined && projectionHash(text) === path.textHash ? text : undefined;
      });
      if (snippets.some((text) => text === undefined)) return undefined;
      return {
        module: entry.module,
        memoryId: entry.memoryId,
        revision: entry.revision,
        title: sourceTitle(source),
        decisionMode: entry.decisionMode,
        content:
          entry.selectedPaths.length > 0
            ? snippets.join("\n\n")
            : memoryProjectionFields(source)
                .map((field) => field.text)
                .join("\n\n"),
      };
    }),
  );
  return {
    contextId: context.contextId,
    entries: entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  };
}

export async function buildMissionRecallPage(
  sources: MissionMemorySourceReader,
  records: readonly MemoryRecallActivity[],
  before: DesktopMissionMemoryRecallPage["nextBefore"],
  limit: number,
  events: readonly ExecutionEvent[] = [],
): Promise<DesktopMissionMemoryRecallPage> {
  const compare = (
    left: { occurredAt: string; id: string },
    right: { occurredAt: string; id: string },
  ) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id);
  const remaining = records
    .filter((record) => before === undefined || compare(record, before) > 0)
    .toSorted(compare);
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const cache = new Map<string, Promise<RetrievalRecord | undefined>>();
  return {
    records: await Promise.all(
      page.map(async (record) => {
        const query = recallSearchQuery(record, events);
        return {
          id: record.id,
          operation: record.operation,
          target: record.target,
          ...(query === undefined ? {} : { query }),
          outcome: record.outcome,
          reason: record.reason,
          occurredAt: record.occurredAt,
          sources: await Promise.all(
            record.resultRefs.map(async (ref) => {
              if (record.outcome !== "allowed") return { ...ref, available: false };
              const match = /^(episodic|semantic)\/items\/([^/]+)\.md$/.exec(ref.id);
              if (match === null) return { ...ref, available: record.outcome === "allowed" };
              let pending = cache.get(ref.id);
              if (pending === undefined) {
                pending = readSource(sources, match[1] as "episodic" | "semantic", match[2]!);
                cache.set(ref.id, pending);
              }
              const source = await pending;
              return {
                ...ref,
                available: source !== undefined,
                ...(source === undefined
                  ? {}
                  : {
                      title: sourceTitle(source),
                      currentRevision: String(source.record.revision),
                    }),
              };
            }),
          ),
        };
      }),
    ),
    ...(remaining.length > limit && last !== undefined
      ? { nextBefore: { occurredAt: last.occurredAt, id: last.id } }
      : {}),
  };
}

export function recallSearchQuery(
  record: MemoryRecallActivity,
  events: readonly ExecutionEvent[],
): string | undefined {
  if (
    record.operation !== "search" ||
    record.outcome !== "allowed" ||
    record.queryDigest === undefined
  )
    return undefined;
  for (const event of events) {
    if (
      event.executionId !== record.executionId ||
      event.invocationId !== record.invocationId ||
      event.type !== "runtime.event"
    )
      continue;
    const parsed = ExpertAgentToolStartedEventSchema.safeParse(event.data);
    if (!parsed.success || !/(^|__)search_expert_context$/.test(parsed.data.payload.toolName))
      continue;
    const input = parsed.data.payload.inputPreview;
    if (
      typeof input !== "object" ||
      input === null ||
      !("query" in input) ||
      typeof input.query !== "string"
    )
      continue;
    const query = input.query.trim();
    if (memoryQueryDigest(query) === record.queryDigest) return query;
  }
  return undefined;
}
