import { createHash } from "node:crypto";
import { z } from "zod";
import { defaultRuntimeTokenCounter } from "@pragma/core";
import {
  extractionMemoryHandle,
  extractionMemoryRef,
  type ExtractionMemoryRecord,
} from "../../retrieval/extraction-memory.ts";
import { memoryProjectionFields, redactMemoryProjection } from "../../retrieval/projection.ts";
import { boundedPrefix, deliver, subjects, responseContentTokens } from "./evidence.ts";
import {
  MemoryExtractionToolSchemas,
  Fact,
  fail,
  type ExtractionExistingFact,
  type MemoryExtractionSessionGuard,
  type SessionState,
} from "./schema.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const Cursor = z
  .object({
    v: z.literal(1),
    session: z.string(),
    scope: z.string(),
    filter: z.string(),
    snapshot: z.string(),
    after: z.string(),
  })
  .strict();
function access(guard: MemoryExtractionSessionGuard) {
  if (guard.memory === undefined) fail("memory_curator_memory_unavailable");
  return guard.memory;
}
export function projectExistingFact(fact: ExtractionExistingFact): ExtractionExistingFact {
  // Authority records carry governance and provenance fields that do not belong
  // in the extraction Session's strict fact snapshot.
  return Fact.parse({
    id: fact.id,
    revision: fact.revision,
    statement: fact.statement,
    subjectRefs: fact.subjectRefs,
    predicate: fact.predicate,
    normalizedValue: fact.normalizedValue,
    conflictMode: fact.conflictMode,
    observedAt: fact.observedAt,
  });
}
export async function existingFact(
  state: SessionState,
  guard: MemoryExtractionSessionGuard,
  handle: string,
): Promise<ExtractionExistingFact | undefined> {
  if (!handle.startsWith("memory:")) {
    await guard.memory?.assertAccess();
    const fact = state.facts[Number(/^[pf]([1-9]\d*)$/u.exec(handle)?.[1]) - 1];
    if (
      fact !== undefined &&
      guard.memory !== undefined &&
      (await guard.memory.get(extractionMemoryRef("semantic", fact.id, fact.revision))) ===
        undefined
    )
      fail("memory_curator_fact_stale_or_denied");
    return fact;
  }
  const memory = await access(guard).get(handle);
  if (memory?.module !== "semantic") fail("memory_curator_fact_stale_or_denied");
  return projectExistingFact(memory.record);
}
function summary(
  memory: ExtractionMemoryRecord,
  aliases: ReturnType<typeof subjects>,
  contract: 1 | 2,
): string {
  const handle = extractionMemoryHandle(memory);
  return memory.module === "semantic"
    ? `${handle} · semantic · Subjects: ${memory.record.subjectRefs.map((ref) => aliases.find((alias) => alias.ref.type === ref.type && alias.ref.id === ref.id)?.alias ?? ref.type).join(", ")} · Property ${memory.record.predicate} (${memory.record.conflictMode}); value: ${redactMemoryProjection(memory.record.normalizedValue).slice(0, 100)}; ${redactMemoryProjection(memory.record.statement).slice(0, 120)}; conflicts: ${memory.record.conflictsWith.length}. ${contract === 1 ? "Use this memory handle as property or replaces when submitting a fact." : "Use this handle with read_existing_memory or replaces; reuse the listed predicate and conflictMode."}`
    : `${handle} · episodic · Historical background, not new evidence · Conversation ${memory.record.conversationRef.id}; ${redactMemoryProjection(memory.record.goal.text).slice(0, 120)}`;
}
export async function readExistingMemory(
  state: SessionState,
  guard: MemoryExtractionSessionGuard,
  handle: string,
  cursor: number,
): Promise<string> {
  const memory = await access(guard).get(handle);
  if (memory === undefined) fail("memory_curator_memory_stale_or_denied");
  const text =
    memoryProjectionFields(memory)
      .map((field) => `${field.path}: ${field.text}`)
      .join("\n\n") +
    (memory.module === "semantic"
      ? `\nConfidence: ${memory.record.confidence}\nObserved at: ${memory.record.observedAt}\nReview at: ${memory.record.reviewAt ?? "none"}\nExpires at: ${memory.record.expiresAt ?? "none"}\nConflict IDs: ${memory.record.conflictsWith.join(", ")}`
      : `\nOutcome status: ${memory.record.outcome.status}`);
  if (cursor > text.length) fail("memory_curator_cursor_invalid");
  const fragment = boundedPrefix(text.slice(cursor), responseContentTokens(state) - 600),
    next = cursor + fragment.length;
  // Revalidate after preparing the response as well as on entry.
  if ((await access(guard).get(handle)) === undefined)
    fail("memory_curator_memory_stale_or_denied");
  return deliver(
    state,
    `${summary(memory, subjects(state, guard.memory?.subjects), state.toolContractVersion)}\nExisting memory is context, not new evidence.\n${fragment}\nNext cursor: ${next < text.length ? next : "end"}`,
  );
}
export async function searchExistingMemory(
  state: SessionState,
  guard: MemoryExtractionSessionGuard,
  args: Pick<
    z.infer<typeof MemoryExtractionToolSchemas.find_existing_memory>,
    "query" | "mode" | "type" | "limit"
  >,
  stagedPrefix = "",
): Promise<string> {
  const result = await access(guard).search({
    query: args.query,
    mode: args.mode,
    type: args.type,
    limit: args.limit,
    signal: guard.signal,
  });
  const lines = [
    stagedPrefix,
    `Search mode: ${result.mode}${result.reason === undefined ? "" : `; ${result.reason}`}. Ranked results are not exhaustive; use list_existing_memory for complete scoped enumeration.`,
    "Existing memories are context, not new evidence.",
  ];
  let available = 0;
  for (const item of result.items) {
    if ((await access(guard).get(extractionMemoryHandle(item.memory))) === undefined) continue;
    available++;
    const line = `${summary(item.memory, subjects(state, guard.memory?.subjects), state.toolContractVersion)} · matched by ${item.matchedBy.join("+")}`;
    if (
      defaultRuntimeTokenCounter.countText([...lines, line].join("\n")).tokens >
      responseContentTokens(state) - 200
    )
      break;
    lines.push(line);
  }
  if (lines.length === 3 && available > 0) fail("memory_curator_memory_item_too_large");
  if (lines.length === 3) lines.push("No matching accessible memory.");
  return deliver(state, lines.join("\n"));
}
export async function listExistingMemory(
  state: SessionState,
  guard: MemoryExtractionSessionGuard,
  args: z.infer<typeof MemoryExtractionToolSchemas.list_existing_memory>,
): Promise<string> {
  const reader = access(guard);
  const aliases = subjects(state, reader.subjects);
  const subject =
    args.subject === undefined
      ? undefined
      : aliases.find((item) => item.alias === args.subject)?.ref;
  if (args.subject !== undefined && subject === undefined)
    fail("memory_curator_subject_ref_invalid");
  const matches = (refs: readonly { type: string; id: string }[]) =>
    subject === undefined || refs.some((ref) => ref.type === subject.type && ref.id === subject.id);
  const items = (await reader.list(args.directory === "episodes" ? "episodic" : "semantic")).filter(
    (item) =>
      item.module === "semantic"
        ? matches(item.record.subjectRefs) &&
          (args.property === undefined || item.record.predicate === args.property)
        : matches([...item.record.rootRefs, ...item.record.producerRefs]) &&
          (args.conversation === undefined || item.record.conversationRef.id === args.conversation),
  );
  let rows: { key: string; text: string; memories: ExtractionMemoryRecord[] }[];
  if (args.directory === "properties") {
    const groups = new Map<
      string,
      {
        memory: Extract<ExtractionMemoryRecord, { module: "semantic" }>;
        count: number;
        modes: Set<string>;
        memories: ExtractionMemoryRecord[];
      }
    >();
    for (const memory of items) {
      if (memory.module !== "semantic") continue;
      const key = JSON.stringify([
        memory.record.subjectRefs.map((ref) => `${ref.type}:${ref.id}`).sort(),
        memory.record.predicate,
      ]);
      const group = groups.get(key) ?? {
        memory,
        count: 0,
        modes: new Set<string>(),
        memories: [],
      };
      group.count++;
      group.modes.add(memory.record.conflictMode);
      group.memories.push(memory);
      groups.set(key, group);
    }
    rows = [...groups].map(([key, group]) => ({
      key,
      memories: group.memories,
      text: `Property ${group.memory.record.predicate}; subjects: ${group.memory.record.subjectRefs.map((ref) => aliases.find((a) => a.ref.type === ref.type && a.ref.id === ref.id)?.alias ?? ref.type).join(", ")}; conflict modes: ${[...group.modes].sort().join(", ")}; facts: ${group.count}; example: ${redactMemoryProjection(group.memory.record.statement).slice(0, 120)}${group.modes.size > 1 ? "; inconsistent conflict modes: inspect facts before reusing" : ""}`,
    }));
  } else
    rows = items.map((memory) => ({
      key: extractionMemoryHandle(memory),
      text: summary(memory, aliases, state.toolContractVersion),
      memories: [memory],
    }));
  rows.sort((a, b) => a.key.localeCompare(b.key));
  const filter = digest({ ...args, pageCursor: undefined, limit: undefined });
  const snapshot = digest(items.map((item) => [item.module, item.record.id, item.record.revision]));
  let after: string | undefined;
  if (args.pageCursor !== undefined) {
    const parsed = Cursor.safeParse(
      (() => {
        try {
          return JSON.parse(Buffer.from(args.pageCursor!, "base64url").toString("utf8"));
        } catch {
          return undefined;
        }
      })(),
    );
    if (
      !parsed.success ||
      parsed.data.session !== state.key ||
      parsed.data.scope !== reader.fingerprint ||
      parsed.data.filter !== filter ||
      parsed.data.snapshot !== snapshot
    )
      fail("memory_curator_cursor_stale");
    after = rows.find((row) => digest(row.key) === parsed.data.after)?.key;
    if (after === undefined) fail("memory_curator_cursor_stale");
  }
  const remaining = rows.filter((row) => after === undefined || row.key.localeCompare(after) > 0);
  const emitted: typeof rows = [];
  for (const row of remaining.slice(0, args.limit)) {
    if (
      defaultRuntimeTokenCounter.countText(
        [...emitted.map((item) => item.text), row.text].join("\n"),
      ).tokens >
      responseContentTokens(state) - 600
    )
      break;
    emitted.push(row);
  }
  if (remaining.length > 0 && emitted.length === 0) fail("memory_curator_memory_item_too_large");
  // Listings include excerpts and property aggregates. Validate every contributing
  // revision after building the page, just as search and full-text reads do.
  for (const row of emitted)
    for (const memory of row.memories)
      if ((await reader.get(extractionMemoryHandle(memory))) === undefined)
        fail("memory_curator_cursor_stale");
  await reader.assertAccess();
  const next =
    emitted.length < remaining.length
      ? Buffer.from(
          JSON.stringify({
            v: 1,
            session: state.key,
            scope: reader.fingerprint,
            filter,
            snapshot,
            after: digest(emitted.at(-1)!.key),
          }),
        ).toString("base64url")
      : "end";
  return deliver(
    state,
    `Directory: ${args.directory}. Complete scoped enumeration, not ranked search. Existing memory is not new evidence.\n${emitted.map((item) => item.text).join("\n") || "No accessible entries."}\nNext pageCursor: ${next}`,
  );
}
