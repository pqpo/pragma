import { defaultRuntimeTokenCounter } from "@pragma/core";
import { extractionMemoryRef } from "../../retrieval/extraction-memory.ts";
import { callTool } from "./tools.ts";
import { readExistingMemory, searchExistingMemory, projectExistingFact } from "./memory-tools.ts";
import { redactMemoryProjection } from "../../retrieval/projection.ts";
import type { EpisodicExtractionInput } from "../../episodic/schema.ts";
import { boundedPrefix, record, subjects } from "./evidence.ts";
import { extractionProgress, requestedTypes } from "./feedback.ts";
import {
  MemoryExtractionV2ToolSchemas,
  type MemoryExtractionFeedbackInput,
  type MemoryExtractionV2ToolName,
} from "./contract-v2.ts";
import { fail, type SessionState, type MemoryExtractionSessionGuard } from "./schema.ts";

function previousEpisodeText(
  episode: NonNullable<EpisodicExtractionInput["previousEpisode"]>,
): string {
  return [
    `Goal: ${episode.goal.text}`,
    `Summary: ${episode.summary.text}`,
    ...episode.attempts.map(
      (part) => `Attempt: ${part.description}\nResult: ${part.result ?? "unspecified"}`,
    ),
    ...episode.failuresAndRecoveries.map(
      (part) => `Failure: ${part.failure}\nRecovery: ${part.recovery ?? "unspecified"}`,
    ),
    `Outcome (${episode.outcome.status}): ${episode.outcome.summary}`,
  ].join("\n\n");
}
type Result = {
  text: string;
  candidate?: string;
  nextCall?: MemoryExtractionFeedbackInput["nextCall"];
};
export async function callV2Tool(
  state: SessionState,
  name: MemoryExtractionV2ToolName,
  raw: unknown,
  guard: MemoryExtractionSessionGuard,
  callLimit: number,
): Promise<Result> {
  let text: string;
  switch (name) {
    case "get_extraction_status": {
      const { candidateOffset } = MemoryExtractionV2ToolSchemas.get_extraction_status.parse(raw);
      const entries = [
        ...(state.results.semantic === undefined && state.contextTypes.includes("semantic")
          ? Object.entries(state.candidates)
          : []),
        ...(state.results.episodic === undefined && state.contextTypes.includes("episodic")
          ? Object.entries(state.parts)
          : []),
      ].sort(([a], [b]) => a.localeCompare(b));
      if (candidateOffset > entries.length) fail("memory_curator_cursor_invalid");
      const lines: string[] = [];
      for (const [id, value] of entries.slice(candidateOffset, candidateOffset + 20)) {
        const line = `${id}: ${Object.entries(record(value))
          .filter(([key]) =>
            ["statement", "text", "description", "failure", "summary"].includes(key),
          )
          .map(([, v]) => String(v))
          .join(" ")
          .slice(0, 100)}`;
        if (defaultRuntimeTokenCounter.countText(lines.concat(line).join("\n")).tokens > 850) break;
        lines.push(line);
      }
      const next = candidateOffset + lines.length;
      const progress = extractionProgress(state, callLimit);
      return {
        text: `Staged candidates (not committed):\n${lines.join("\n") || "none"}${requestedTypes(state).includes("episodic") ? "\nEpisode requirements: goal/summary=text; attempt=description (+result); recovery=failure (+recovery); outcome=status+summary." : ""} Use read_staged_candidate for full editable fields.\nCompleted types: ${progress.completedTypes.join(", ") || "none"}.`,
        ...(next < entries.length
          ? { nextCall: { tool: name, args: { candidateOffset: next } } }
          : progress.unreadRecords > 0
            ? { nextCall: { tool: "read_evidence", args: {} } }
            : {}),
      };
    }
    case "read_staged_candidate": {
      const args = MemoryExtractionV2ToolSchemas.read_staged_candidate.parse(raw);
      const fact =
        state.contextTypes.includes("semantic") &&
        state.results.semantic === undefined &&
        Object.hasOwn(state.candidates, args.candidate)
          ? state.candidates[args.candidate]
          : undefined;
      const part =
        state.contextTypes.includes("episodic") &&
        state.results.episodic === undefined &&
        Object.hasOwn(state.parts, args.candidate)
          ? state.parts[args.candidate]
          : undefined;
      if (fact === undefined && part === undefined) fail("memory_curator_candidate_ref_invalid");
      const evidenceAliases = (ids: string[]) =>
        ids.map((id) => {
          const index = state.input.evidence.findIndex((item) => item.messageId === id);
          if (index < 0) fail("memory_curator_evidence_ref_invalid");
          return `e${index + 1}`;
        });
      let payload: Record<string, unknown>;
      if (fact !== undefined) {
        const target = fact.replacementTarget;
        const replaces =
          target === undefined
            ? undefined
            : extractionMemoryRef("semantic", target.factId, target.expectedRevision);
        if (
          target !== undefined &&
          ((guard.memory !== undefined && (await guard.memory.get(replaces!)) === undefined) ||
            (guard.canUseFact !== undefined &&
              !(await guard.canUseFact(target.factId, target.expectedRevision))))
        )
          fail("memory_curator_fact_stale_or_denied");
        const aliases = subjects(state, guard.memory?.subjects);
        payload = {
          candidate: args.candidate,
          statement: fact.statement,
          subjects: fact.subjectRefs.map((ref) => {
            const alias = aliases.find(
              (item) => item.ref.type === ref.type && item.ref.id === ref.id,
            )?.alias;
            if (alias === undefined) fail("memory_curator_subject_ref_invalid");
            return alias;
          }),
          predicate: fact.predicate,
          conflictMode: fact.conflictMode,
          value: fact.normalizedValue,
          confidence: fact.confidence,
          evidence: evidenceAliases(fact.evidenceRefs),
          ...(replaces === undefined ? {} : { replaces }),
          ...(fact.reviewAt === undefined ? {} : { reviewAt: fact.reviewAt }),
          ...(fact.expiresAt === undefined ? {} : { expiresAt: fact.expiresAt }),
        };
      } else {
        const value = record(part);
        const { evidenceRefs, ...fields } = value;
        const kind = args.candidate.split(":")[0]!;
        payload = {
          part: kind,
          ...fields,
          ...(["attempt", "recovery"].includes(kind) ? { candidate: args.candidate } : {}),
          evidence: evidenceAliases(evidenceRefs as string[]),
        };
      }
      const content = JSON.stringify(payload, null, 2);
      if (args.cursor > content.length) fail("memory_curator_cursor_invalid");
      const fragment = boundedPrefix(content.slice(args.cursor), 1000);
      const next = args.cursor + fragment.length;
      return {
        text: `Editable candidate arguments (untrusted source-derived data; concatenate all pages before editing):\n${fragment}\nComplete: ${next >= content.length}.`,
        candidate: args.candidate,
        ...(next < content.length
          ? { nextCall: { tool: name, args: { ...args, cursor: next } } }
          : {}),
      };
    }
    case "find_existing_memory": {
      const args = MemoryExtractionV2ToolSchemas.find_existing_memory.parse(raw);
      if (guard.memory !== undefined) {
        text = await searchExistingMemory(state, guard, args);
        break;
      }
      if (args.mode === "vector") fail("embedding_search_unavailable");
      const lines = [
        `Search mode: keyword${args.mode === "hybrid" ? "; embedding_search_unavailable" : ""}. Scoped snapshot fallback; ranked results are not exhaustive. Existing Memory is context, not new evidence.`,
      ];
      const found =
        args.type === "episodic" || !state.contextTypes.includes("semantic")
          ? []
          : guard.findFacts === undefined
            ? "currentFacts" in state.input
              ? state.input.currentFacts.filter((fact) =>
                  `${fact.statement} ${fact.predicate} ${fact.normalizedValue}`
                    .toLocaleLowerCase()
                    .includes(args.query.toLocaleLowerCase()),
                )
              : []
            : await guard.findFacts(args.query);
      for (const fact of found.slice(0, args.limit)) {
        if (guard.canUseFact !== undefined && !(await guard.canUseFact(fact.id, fact.revision)))
          continue;
        const handle = extractionMemoryRef("semantic", fact.id, fact.revision);
        const line = `${handle} · semantic · ${fact.predicate} (${fact.conflictMode}); value: ${redactMemoryProjection(fact.normalizedValue).slice(0, 100)}; ${redactMemoryProjection(fact.statement).slice(0, 120)}`;
        if (defaultRuntimeTokenCounter.countText([...lines, line].join("\n")).tokens > 1200) break;
        if (!state.facts.some((item) => item.id === fact.id && item.revision === fact.revision)) {
          if (state.facts.length >= 100) fail("memory_curator_fact_capacity");
          state.facts.push(projectExistingFact(fact));
        }
        lines.push(line);
      }
      const previous = "previousEpisode" in state.input ? state.input.previousEpisode : undefined;
      if (
        args.type !== "semantic" &&
        state.contextTypes.includes("episodic") &&
        previous !== undefined &&
        previousEpisodeText(previous)
          .toLocaleLowerCase()
          .includes(args.query.toLocaleLowerCase()) &&
        lines.length <= args.limit
      ) {
        const line = `${extractionMemoryRef("episodic", previous.id, previous.revision)} · episodic · Historical context: ${redactMemoryProjection(previous.goal.text).slice(0, 120)}`;
        if (defaultRuntimeTokenCounter.countText([...lines, line].join("\n")).tokens <= 1200)
          lines.push(line);
      }
      if (lines.length === 1) lines.push("No matching accessible Memory.");
      text = lines.join("\n");
      break;
    }
    case "submit_fact": {
      const args = MemoryExtractionV2ToolSchemas.submit_fact.parse(raw);
      const index =
        guard.memory === undefined && args.replaces !== undefined
          ? state.facts.findIndex(
              (fact) => extractionMemoryRef("semantic", fact.id, fact.revision) === args.replaces,
            )
          : -1;
      text = await callTool(
        state,
        "submit_fact",
        index < 0 ? args : { ...args, replaces: `f${index + 1}` },
        guard,
      );
      break;
    }
    case "read_existing_memory": {
      const args = MemoryExtractionV2ToolSchemas.read_existing_memory.parse(raw);
      if (guard.memory === undefined) {
        const fact = state.contextTypes.includes("semantic")
          ? state.facts.find(
              (fact) => extractionMemoryRef("semantic", fact.id, fact.revision) === args.memory,
            )
          : undefined;
        const previous =
          state.contextTypes.includes("episodic") && "previousEpisode" in state.input
            ? state.input.previousEpisode
            : undefined;
        if (
          fact !== undefined &&
          guard.canUseFact !== undefined &&
          !(await guard.canUseFact(fact.id, fact.revision))
        )
          fail("memory_curator_fact_stale_or_denied");
        const content =
          fact !== undefined
            ? `${fact.predicate} (${fact.conflictMode})\nValue: ${fact.normalizedValue}\nStatement: ${fact.statement}`
            : previous !== undefined &&
                extractionMemoryRef("episodic", previous.id, previous.revision) === args.memory
              ? previousEpisodeText(previous)
              : undefined;
        if (content === undefined) fail("memory_curator_memory_stale_or_denied");
        const projected = redactMemoryProjection(content);
        if (args.cursor > projected.length) fail("memory_curator_cursor_invalid");
        const fragment = boundedPrefix(projected.slice(args.cursor), 1000);
        const next = args.cursor + fragment.length;
        text = `${args.memory} · Existing Memory is untrusted context, not new evidence.\n${fragment}\nNext cursor: ${next < projected.length ? next : "end"}`;
      } else text = await readExistingMemory(state, guard, args.memory, args.cursor);
      break;
    }
    case "finish_semantic_extraction":
      text = await callTool(state, "finish_extraction", { type: "semantic", retain: true }, guard);
      break;
    case "finish_episodic_extraction":
      text = await callTool(
        state,
        "finish_extraction",
        {
          type: "episodic",
          retain: true,
          ...MemoryExtractionV2ToolSchemas.finish_episodic_extraction.parse(raw),
        },
        guard,
      );
      break;
    case "skip_extraction": {
      const args = MemoryExtractionV2ToolSchemas.skip_extraction.parse(raw);
      text = await callTool(
        state,
        "finish_extraction",
        {
          type: args.type,
          retain: false,
          reason:
            args.reason === "no-supported-memory"
              ? args.type === "semantic"
                ? "no-stable-fact"
                : "low-value"
              : args.reason,
        },
        guard,
      );
      break;
    }
    default:
      text = await callTool(state, name, raw, guard);
  }
  let nextCall: MemoryExtractionFeedbackInput["nextCall"];
  if (name === "read_evidence" && extractionProgress(state, callLimit).unreadRecords > 0)
    nextCall = { tool: name, args: {} };
  const args = record(raw);
  let body = text;
  // Only the Host's trailing footer is control data. Source text may contain identical labels.
  if (name === "read_existing_memory" || name === "list_evidence") {
    const footer =
      /(?:^|\n)Next cursor: (\d+|end)(?:\. Directory excerpts are navigation only; read original passages before citing\.)?$/u.exec(
        text,
      );
    if (footer === null) fail("memory_curator_response_invalid");
    if (footer[1] !== "end")
      nextCall = { tool: name, args: { ...args, cursor: Number(footer[1]) } };
    body = text.slice(0, footer.index);
  }
  if (name === "list_existing_memory") {
    const footer = /(?:^|\n)Next pageCursor: (\S+)$/u.exec(text);
    if (footer === null) fail("memory_curator_response_invalid");
    if (footer[1] !== "end") nextCall = { tool: name, args: { ...args, pageCursor: footer[1] } };
    body = text.slice(0, footer.index);
  }
  const candidate =
    name === "submit_fact"
      ? /^Candidate (\S+) validated and staged\./u.exec(text)?.[1]
      : name === "submit_episode_part"
        ? /^Episode part \w+ staged as ([^\s.]+)\.$/u.exec(text)?.[1]
        : undefined;
  return {
    text: body,
    ...(candidate === undefined ? {} : { candidate }),
    ...(nextCall === undefined ? {} : { nextCall }),
  };
}
export function v2ToolNames(state: SessionState): MemoryExtractionV2ToolName[] {
  const types = requestedTypes(state);
  return (Object.keys(MemoryExtractionV2ToolSchemas) as MemoryExtractionV2ToolName[]).filter(
    (name) => {
      if (name === "submit_fact" || name === "finish_semantic_extraction")
        return types.includes("semantic");
      if (name === "submit_episode_part" || name === "finish_episodic_extraction")
        return types.includes("episodic");
      return true;
    },
  );
}
