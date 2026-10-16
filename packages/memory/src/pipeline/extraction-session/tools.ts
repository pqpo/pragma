import { createHash } from "node:crypto";
import { extractionMemoryRef } from "../../retrieval/extraction-memory.ts";
import {
  existingFact,
  projectExistingFact,
  listExistingMemory,
  readExistingMemory,
  searchExistingMemory,
} from "./memory-tools.ts";
import { defaultRuntimeTokenCounter } from "@pragma/core";
import {
  EpisodicExtractionOutputSchema,
  EpisodicMemoryRecordSchema,
} from "../../episodic/schema.ts";
import {
  SemanticExtractionOutputSchema,
  SemanticFactCandidateSchema,
} from "../../semantic/schema.ts";
import {
  MemoryExtractionToolSchemas,
  MEMORY_EXTRACTION_LIMITS,
  fail,
  type MemoryExtractionToolName,
  type MemoryExtractionSessionGuard,
  type SessionState,
} from "./schema.ts";
import {
  evidenceText,
  deliver,
  boundedPrefix,
  record,
  refs,
  allRead,
  readProgress,
  subjects,
} from "./evidence.ts";
export async function callTool(
  state: SessionState,
  name: MemoryExtractionToolName,
  raw: unknown,
  guard: MemoryExtractionSessionGuard,
): Promise<string> {
  switch (name) {
    case "list_evidence": {
      const args = MemoryExtractionToolSchemas.list_evidence.parse(raw);
      if (args.directory === "subjects") {
        const available = subjects(state, guard.memory?.subjects).filter(
          (subject) => !args.query || `${subject.alias} ${subject.ref.type}`.includes(args.query),
        );
        const page = available.slice(args.cursor, args.cursor + MEMORY_EXTRACTION_LIMITS.pageSize);
        return deliver(
          state,
          [
            ...page.map(
              (subject) => `${subject.alias}: ${subject.ref.type.replace("pragma.", "")}`,
            ),
            `Next cursor: ${args.cursor + page.length < available.length ? args.cursor + page.length : "end"}`,
          ].join("\n"),
        );
      }
      const rows = state.input.evidence
        .map((item, index) => ({ item, index, ...evidenceText(item) }))
        .filter(
          (row) =>
            (!args.role || row.role === args.role) &&
            (!args.query || row.text.toLocaleLowerCase().includes(args.query.toLocaleLowerCase())),
        );
      const selected = rows.slice(args.cursor, args.cursor + MEMORY_EXTRACTION_LIMITS.pageSize);
      const lines: string[] = [];
      for (const { item, index, role, text } of selected) {
        const progress = readProgress(state, `e${index + 1}`);
        const line = `[e${index + 1}] ${role} · ${item.occurredAt} · ${progress >= text.length ? "read fully" : `unread from cursor ${progress}`} · ${text.slice(0, 60).replaceAll("\n", " ")}`;
        if (defaultRuntimeTokenCounter.countText(lines.concat(line).join("\n")).tokens > 1700)
          break;
        lines.push(line);
      }
      return deliver(
        state,
        [
          ...lines,
          `Next cursor: ${args.cursor + lines.length < rows.length ? args.cursor + lines.length : "end"}. Directory excerpts are navigation only; read original passages before citing.`,
        ].join("\n"),
      );
    }
    case "read_evidence": {
      const args = MemoryExtractionToolSchemas.read_evidence.parse(raw);
      const index = Number(/^e([1-9]\d*)$/u.exec(args.evidence)?.[1]) - 1;
      const item = state.input.evidence[index];
      if (item === undefined) fail("memory_curator_evidence_ref_invalid");
      if (args.cursor > evidenceText(item).text.length) fail("memory_curator_cursor_invalid");
      const passages: string[] = [];
      let nextIndex = index;
      let nextCursor = args.cursor;
      // Pack adjacent source passages, including short structural events, into one bounded delivery.
      for (let count = 0; count < MEMORY_EXTRACTION_LIMITS.pageSize; count++) {
        const current = state.input.evidence[nextIndex];
        if (current === undefined) break;
        const { role, text } = evidenceText(current);
        const header = `[e${nextIndex + 1}] ${role} · ${current.occurredAt}\n`;
        const remaining =
          MEMORY_EXTRACTION_LIMITS.responseTokens -
          200 -
          defaultRuntimeTokenCounter.countText(passages.join("\n\n") + header).tokens;
        if (remaining < 100) break;
        const fragment = boundedPrefix(text.slice(nextCursor), remaining);
        const end = nextCursor + fragment.length;
        const passage = header + fragment;
        // Count the packed result as well, since token boundaries may cross separators.
        if (
          defaultRuntimeTokenCounter.countText(passages.concat(passage).join("\n\n")).tokens >
          MEMORY_EXTRACTION_LIMITS.responseTokens - 150
        )
          break;
        passages.push(passage);
        (state.read[`e${nextIndex + 1}`] ??= []).push([nextCursor, end]);
        if (end < text.length) {
          nextCursor = end;
          break;
        }
        nextIndex++;
        nextCursor = 0;
      }
      const next = nextIndex < state.input.evidence.length ? `e${nextIndex + 1}` : "end";
      return deliver(
        state,
        `${passages.join("\n\n")}\nNext evidence: ${next}; Next cursor: ${next === "end" ? "end" : nextCursor}.`,
      );
    }
    case "list_existing_memory":
      return await listExistingMemory(
        state,
        guard,
        MemoryExtractionToolSchemas.list_existing_memory.parse(raw),
      );
    case "find_existing_memory": {
      const args = MemoryExtractionToolSchemas.find_existing_memory.parse(raw);
      await guard.memory?.assertAccess();
      const handle = args.memory ?? (args.fact?.startsWith("memory:") ? args.fact : undefined);
      if (handle !== undefined) return await readExistingMemory(state, guard, handle, args.cursor);
      if (args.fact !== undefined) {
        const fact = /^f[1-9]\d*$/u.test(args.fact)
          ? await existingFact(state, guard, args.fact)
          : undefined;
        if (fact === undefined) fail("memory_curator_fact_ref_invalid");
        if (guard.canUseFact !== undefined && !(await guard.canUseFact(fact.id, fact.revision)))
          fail("memory_curator_fact_stale_or_denied");
        const text = `${fact.predicate} (${fact.conflictMode})\nValue: ${fact.normalizedValue}\nStatement: ${fact.statement}`;
        if (args.cursor > text.length) fail("memory_curator_cursor_invalid");
        const fragment = boundedPrefix(text.slice(args.cursor), 1700);
        const next = args.cursor + fragment.length;
        return deliver(
          state,
          `[${args.fact}] Existing memory, not new evidence.\n${fragment}\nNext cursor: ${next < text.length ? next : "end"}`,
        );
      }
      const staged =
        state.module === "semantic"
          ? Object.entries(state.candidates).map(([key, value]) => `${key}: ${value.statement}`)
          : Object.entries(state.parts).map(
              ([key, value]) =>
                `${key}: ${Object.values(record(value))
                  .filter((v) => typeof v === "string")
                  .join(" · ")}`,
            );
      const stagedText = staged
        .filter((text) => text.toLocaleLowerCase().includes(args.query.toLocaleLowerCase()))
        .slice(0, 10)
        .map((text) => text.slice(0, 160))
        .join("\n");
      const stagedPrefix = stagedText
        ? `Staged work from this snapshot (not committed):\n${boundedPrefix(stagedText, 600)}\n\n`
        : "";
      if (guard.memory !== undefined && args.query.trim() !== "")
        return await searchExistingMemory(state, guard, args, stagedPrefix);
      if (args.mode === "vector") fail("embedding_search_unavailable");
      if (state.module === "episodic") {
        const previous = "previousEpisode" in state.input ? state.input.previousEpisode : undefined;
        if (previous === undefined) return deliver(state, stagedPrefix + "No previous episode.");
        if (
          guard.memory !== undefined &&
          (await guard.memory.get(
            extractionMemoryRef("episodic", previous.id, previous.revision),
          )) === undefined
        )
          fail("memory_curator_memory_stale_or_denied");
        const text = [
          `Goal: ${previous.goal.text}`,
          `Summary: ${previous.summary.text}`,
          ...previous.attempts.map(
            (part) => `Attempt: ${part.description}\nResult: ${part.result ?? "unspecified"}`,
          ),
          ...previous.failuresAndRecoveries.map(
            (part) => `Failure: ${part.failure}\nRecovery: ${part.recovery ?? "unspecified"}`,
          ),
          `Outcome (${previous.outcome.status}): ${previous.outcome.summary}`,
        ].join("\n\n");
        if (args.cursor > text.length) fail("memory_curator_cursor_invalid");
        const fragment = boundedPrefix(text.slice(args.cursor), 1100);
        const next = args.cursor + fragment.length;
        return deliver(
          state,
          `${stagedPrefix}Previous episode (context, not new evidence):\n${fragment}\nNext cursor: ${next < text.length ? next : "end"}`,
        );
      }
      const found =
        guard.findFacts === undefined
          ? "currentFacts" in state.input
            ? state.input.currentFacts
                .filter((fact) =>
                  JSON.stringify(fact).toLocaleLowerCase().includes(args.query.toLocaleLowerCase()),
                )
                .slice(0, 10)
            : []
          : await guard.findFacts(args.query);
      const lines: string[] = [];
      for (const fact of found.slice(0, 10)) {
        if (
          guard.memory !== undefined &&
          (await guard.memory.get(extractionMemoryRef("semantic", fact.id, fact.revision))) ===
            undefined
        )
          continue;
        let index = state.facts.findIndex(
          (item) => item.id === fact.id && item.revision === fact.revision,
        );
        if (index < 0) {
          if (state.facts.length >= 100) fail("memory_curator_fact_capacity");
          index = state.facts.length;
        }
        const line = `[f${index + 1}] Property p${index + 1}: ${fact.predicate} (${fact.conflictMode}); value excerpt: ${fact.normalizedValue.slice(0, 160)}\nStatement excerpt: ${fact.statement.slice(0, 240)}\nRead full text with fact=f${index + 1}.`;
        if (defaultRuntimeTokenCounter.countText(lines.concat(line).join("\n\n")).tokens > 1100)
          break;
        if (index === state.facts.length) state.facts.push(projectExistingFact(fact));
        lines.push(line);
      }
      return deliver(
        state,
        stagedPrefix +
          (lines.join("\n\n") ||
            "No matching accessible current facts. New properties require a namespaced predicate and conflictMode: exclusive or compatible."),
      );
    }
    case "submit_fact": {
      const args = MemoryExtractionToolSchemas.submit_fact.parse(raw);
      const existingProperty =
        typeof args.property === "string"
          ? await existingFact(state, guard, args.property)
          : undefined;
      const property = typeof args.property === "string" ? existingProperty : args.property;
      if (property === undefined) fail("memory_curator_property_ref_invalid");
      if (
        existingProperty !== undefined &&
        guard.canUseFact !== undefined &&
        !(await guard.canUseFact(existingProperty.id, existingProperty.revision))
      )
        fail("memory_curator_fact_stale_or_denied");
      const replacement =
        args.replaces === undefined ? undefined : await existingFact(state, guard, args.replaces);
      if (args.replaces !== undefined && replacement === undefined)
        fail("memory_curator_fact_ref_invalid");
      if (
        replacement !== undefined &&
        guard.canUseFact !== undefined &&
        !(await guard.canUseFact(replacement.id, replacement.revision))
      )
        fail("memory_curator_fact_stale_or_denied");
      const subjectRefs = args.subjects.map((alias) => {
        const subject = subjects(state).find((item) => item.alias === alias);
        if (subject === undefined) fail("memory_curator_subject_ref_invalid");
        return subject.ref;
      });
      const evidenceRefs = refs(state, args.evidence);
      if (replacement !== undefined) {
        const key = (items: typeof subjectRefs) =>
          JSON.stringify(items.map((ref) => `${ref.type}:${ref.id}`).sort());
        if (
          replacement.predicate !== property.predicate ||
          replacement.conflictMode !== "exclusive" ||
          property.conflictMode !== "exclusive" ||
          replacement.normalizedValue === args.value ||
          key(replacement.subjectRefs) !== key(subjectRefs)
        )
          fail("semantic_replacement_target_invalid");
        if (
          !state.input.evidence.some(
            (item) =>
              evidenceRefs.includes(item.messageId) &&
              record(record(item.payload)["message"])["role"] === "user",
          )
        )
          fail("semantic_replacement_not_authoritative");
      }
      const candidate = SemanticFactCandidateSchema.parse({
        statement: args.statement,
        subjectRefs,
        predicate: property.predicate,
        normalizedValue: args.value,
        conflictMode: property.conflictMode,
        confidence: args.confidence,
        evidenceRefs,
        ...(replacement === undefined
          ? {}
          : {
              replacementTarget: { factId: replacement.id, expectedRevision: replacement.revision },
            }),
        ...(args.reviewAt === undefined ? {} : { reviewAt: args.reviewAt }),
        ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
      });
      const observedAt = state.input.evidence
        .filter((item) => evidenceRefs.includes(item.messageId))
        .map((item) => item.occurredAt)
        .sort()
        .at(-1)!;
      if (
        (candidate.reviewAt !== undefined && candidate.reviewAt <= observedAt) ||
        (candidate.expiresAt !== undefined && candidate.expiresAt <= observedAt)
      )
        fail("semantic_candidate_time_invalid");
      const digest = createHash("sha256")
        .update(JSON.stringify(candidate))
        .digest("hex")
        .slice(0, 16);
      const id = args.candidate ?? `c${digest}`;
      if (args.candidate !== undefined && state.candidates[id] === undefined)
        fail("memory_curator_candidate_ref_invalid");
      if (state.candidates[id] === undefined && Object.keys(state.candidates).length >= 50)
        fail("memory_curator_candidate_capacity");
      state.candidates[id] = candidate;
      return `Candidate ${id} validated and staged. Memory has not been committed.`;
    }
    case "submit_episode_part": {
      const args = MemoryExtractionToolSchemas.submit_episode_part.parse(raw);
      const evidenceRefs = refs(state, args.evidence);
      const digest = createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
      const multiple = args.part === "attempt" || args.part === "recovery";
      const id = multiple ? (args.candidate ?? `${args.part}:${digest}`) : args.part;
      if (
        multiple &&
        args.candidate !== undefined &&
        (!id.startsWith(`${args.part}:`) || state.parts[id] === undefined)
      )
        fail("memory_curator_candidate_ref_invalid");
      if (
        Object.keys(state.parts).filter((key) => key.startsWith(`${args.part}:`)).length >= 50 &&
        state.parts[id] === undefined
      )
        fail("memory_curator_candidate_capacity");
      const { part, ...rest } = args;
      const value = record(rest);
      delete value["candidate"];
      delete value["evidence"];
      state.parts[id] = { ...value, evidenceRefs };
      return `Episode part ${part} staged as ${id}.`;
    }
    case "finish_extraction": {
      const args = MemoryExtractionToolSchemas.finish_extraction.parse(raw);
      if (!allRead(state)) fail("memory_curator_evidence_incomplete");
      if (state.provenance === undefined) fail("memory_curator_provenance_missing");
      for (const candidate of Object.values(state.candidates)) {
        const target = candidate.replacementTarget;
        if (
          target !== undefined &&
          guard.memory !== undefined &&
          (await guard.memory.get(
            extractionMemoryRef("semantic", target.factId, target.expectedRevision),
          )) === undefined
        )
          fail("memory_curator_fact_stale_or_denied");
        if (
          target !== undefined &&
          guard.canUseFact !== undefined &&
          !(await guard.canUseFact(target.factId, target.expectedRevision))
        )
          fail("memory_curator_fact_stale_or_denied");
      }
      let output: unknown = args;
      if (args.retain) {
        if (state.module === "semantic")
          output = { retain: true, facts: Object.values(state.candidates) };
        else
          output = {
            retain: true,
            language: args.language,
            valueScore: args.valueScore,
            goal: state.parts["goal"],
            summary: state.parts["summary"],
            outcome: state.parts["outcome"],
            attempts: Object.entries(state.parts)
              .filter(([key]) => key.startsWith("attempt:"))
              .map(([, v]) => v),
            failuresAndRecoveries: Object.entries(state.parts)
              .filter(([key]) => key.startsWith("recovery:"))
              .map(([, v]) => v),
          };
      }
      if (state.module === "episodic" && args.retain) {
        const evidenceRefs = new Set<string>();
        for (const part of Object.values(state.parts)) {
          for (const ref of record(part)["evidenceRefs"] as string[]) evidenceRefs.add(ref);
        }
        EpisodicMemoryRecordSchema.shape.evidenceRefs.parse([...evidenceRefs]);
      }
      state.output =
        state.module === "semantic"
          ? SemanticExtractionOutputSchema.parse(output)
          : EpisodicExtractionOutputSchema.parse(output);
      return "Extraction completed. A durable result receipt has been saved; the Host will commit Memory.";
    }
  }
}
