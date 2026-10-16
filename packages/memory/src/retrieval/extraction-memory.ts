import { createHash } from "node:crypto";
import { z } from "zod";
import type { MemorySubjectRef } from "@pragma/shared";
import type { SemanticMemoryStore } from "../semantic/store.ts";
import type { EpisodicMemoryStore } from "../episodic/store.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";
import { memoryProjectionFields, type RetrievalRecord } from "./projection.ts";
import { fuseMemoryRanks } from "./rank-fusion.ts";

export const ExtractionMemoryTypeSchema = z.enum(["semantic", "episodic", "all"]);
export const ExtractionSearchModeSchema = z.enum(["hybrid", "keyword", "vector"]);
export type ExtractionMemoryType = z.infer<typeof ExtractionMemoryTypeSchema>;
export type ExtractionSearchMode = z.infer<typeof ExtractionSearchModeSchema>;
export type ExtractionMemoryRecord = RetrievalRecord;
export interface ExtractionVectorResult {
  readonly state: "ready" | "disabled" | "unavailable";
  readonly reason?: string | undefined;
  readonly hits: readonly { module: "semantic" | "episodic"; memoryId: string; revision: number }[];
}
export type ExtractionVectorSearch = (
  scope: MemoryRecallScope,
  query: string,
  modules: readonly ("semantic" | "episodic")[],
  limit: number,
  signal: AbortSignal,
) => Promise<ExtractionVectorResult>;
export interface ExtractionMemoryAccess {
  assertAccess(): Promise<void>;
  readonly fingerprint: string;
  readonly subjects: readonly MemorySubjectRef[];
  list(type: ExtractionMemoryType): Promise<readonly ExtractionMemoryRecord[]>;
  get(handle: string): Promise<ExtractionMemoryRecord | undefined>;
  search(input: {
    query: string;
    type: ExtractionMemoryType;
    mode: ExtractionSearchMode;
    limit: number;
    signal?: AbortSignal | undefined;
  }): Promise<{
    items: readonly { memory: ExtractionMemoryRecord; matchedBy: readonly string[] }[];
    mode: ExtractionSearchMode;
    reason?: string | undefined;
  }>;
}
export interface ExtractionMemoryReader {
  bind(
    scope: MemoryRecallScope,
    subjects: readonly MemorySubjectRef[],
    recallAllowed?: boolean,
    producerRefs?: readonly MemorySubjectRef[],
  ): ExtractionMemoryAccess;
}
const Handle = z
  .object({
    module: z.enum(["semantic", "episodic"]),
    id: z.string().min(1),
    revision: z.number().int().positive(),
  })
  .strict();
export function extractionMemoryHandle(memory: ExtractionMemoryRecord): string {
  return extractionMemoryRef(memory.module, memory.record.id, memory.record.revision);
}
export function extractionMemoryRef(
  module: "semantic" | "episodic",
  id: string,
  revision: number,
): string {
  return `memory:${Buffer.from(JSON.stringify({ module, id, revision })).toString("base64url")}`;
}
const refKey = (ref: MemorySubjectRef) => `${ref.type}:${ref.id}`;
const memoryKey = (memory: ExtractionMemoryRecord) => `${memory.module}:${memory.record.id}`;
export function createExtractionMemoryReader(options: {
  semantic: Pick<SemanticMemoryStore, "listCandidatesForRecall" | "peekForRecall">;
  episodic: Pick<EpisodicMemoryStore, "listCandidatesForRecall" | "peekForRecall">;
  assertAccess: (
    scope: MemoryRecallScope,
    producerRefs: readonly MemorySubjectRef[],
  ) => Promise<void>;
  vectorSearch?: ExtractionVectorSearch | undefined;
  now?: (() => Date) | undefined;
}): ExtractionMemoryReader {
  const now = options.now ?? (() => new Date());
  return {
    bind(initialScope, initialSubjects, recallAllowed = true, initialProducers = []) {
      const scope = structuredClone(initialScope);
      const subjects = initialSubjects.map((ref) => ({ ...ref }));
      const producerRefs = initialProducers.map((ref) => ({ ...ref }));
      const assertAccess = async () => {
        if (!recallAllowed) throw new Error("memory_curator_recall_denied");
        await options.assertAccess(scope, producerRefs);
      };
      const allowed = new Set(subjects.map(refKey));
      const permitted = (memory: ExtractionMemoryRecord) =>
        memory.record.status === "active" &&
        memory.record.sensitivity !== "restricted" &&
        (memory.module !== "semantic" ||
          (memory.record.subjectRefs.every((ref) => allowed.has(refKey(ref))) &&
            (memory.record.expiresAt === undefined ||
              memory.record.expiresAt > now().toISOString())));
      const access: ExtractionMemoryAccess = {
        assertAccess,
        subjects,
        fingerprint: createHash("sha256")
          .update(JSON.stringify([scope, [...allowed].sort()]))
          .digest("hex"),
        async list(type) {
          await assertAccess();
          const items: ExtractionMemoryRecord[] = [];
          if (type !== "episodic")
            for (const record of await options.semantic.listCandidatesForRecall(scope, now()))
              items.push({ module: "semantic", record });
          if (type !== "semantic")
            for (const record of await options.episodic.listCandidatesForRecall(scope, now()))
              items.push({ module: "episodic", record });
          await assertAccess();
          return items.filter(permitted).sort((a, b) => memoryKey(a).localeCompare(memoryKey(b)));
        },
        async get(handle) {
          if (!handle.startsWith("memory:") || handle.length > 4096) return undefined;
          let ref: z.infer<typeof Handle>;
          try {
            ref = Handle.parse(
              JSON.parse(Buffer.from(handle.slice(7), "base64url").toString("utf8")),
            );
          } catch {
            return undefined;
          }
          await assertAccess();
          const timestamp = now();
          const memory: ExtractionMemoryRecord | undefined =
            ref.module === "semantic"
              ? await options.semantic
                  .peekForRecall(scope, ref.id, timestamp)
                  .then((record) =>
                    record === undefined ? undefined : { module: "semantic" as const, record },
                  )
              : await options.episodic
                  .peekForRecall(scope, ref.id, timestamp)
                  .then((record) =>
                    record === undefined ? undefined : { module: "episodic" as const, record },
                  );
          await assertAccess();
          return memory !== undefined &&
            memory.record.revision === ref.revision &&
            permitted(memory)
            ? memory
            : undefined;
        },
        async search(input) {
          await assertAccess();
          input.signal?.throwIfAborted();
          let vectors: ExtractionVectorResult = {
            state: "disabled",
            hits: [],
            reason: "embedding_disabled",
          };
          if (input.mode !== "keyword" && options.vectorSearch !== undefined) {
            try {
              vectors = await options.vectorSearch(
                scope,
                input.query,
                input.type === "all" ? ["semantic", "episodic"] : [input.type],
                Math.min(input.limit * 4, 80),
                input.signal ?? AbortSignal.timeout(3000),
              );
            } catch (error) {
              input.signal?.throwIfAborted();
              vectors = {
                state: "unavailable",
                hits: [],
                reason:
                  error instanceof Error && /^embedding_[a-z_]+$/u.test(error.message)
                    ? error.message
                    : "embedding_search_unavailable",
              };
            }
          }
          input.signal?.throwIfAborted();
          await assertAccess();
          if (input.mode === "vector" && vectors.state !== "ready")
            throw new Error(vectors.reason ?? "embedding_search_unavailable");
          // Rebuild from current authority after network retrieval, never trust cached excerpts.
          const items = await access.list(input.type);
          const query = input.query.trim().toLocaleLowerCase();
          const lexical =
            input.mode === "vector"
              ? []
              : items.filter((item) =>
                  memoryProjectionFields(item).some((field) =>
                    field.text.toLocaleLowerCase().includes(query),
                  ),
                );
          const vectorItems = vectors.hits.flatMap((hit) => {
            const current = items.find(
              (item) =>
                item.module === hit.module &&
                item.record.id === hit.memoryId &&
                item.record.revision === hit.revision,
            );
            return current === undefined ? [] : [current];
          });
          const lexicalKeys = new Set(lexical.map(memoryKey)),
            vectorKeys = new Set(vectorItems.map(memoryKey));
          const ranked = fuseMemoryRanks([lexical, vectorItems], memoryKey).slice(0, input.limit);
          const result = [];
          for (const item of ranked) {
            const current = await access.get(extractionMemoryHandle(item));
            if (current !== undefined)
              result.push({
                memory: current,
                matchedBy: [
                  lexicalKeys.has(memoryKey(item)) ? "keyword" : "",
                  vectorKeys.has(memoryKey(item)) ? "vector" : "",
                ].filter(Boolean),
              });
          }
          await assertAccess();
          return {
            items: result,
            mode: input.mode === "hybrid" && vectors.state !== "ready" ? "keyword" : input.mode,
            ...(input.mode !== "keyword" && vectors.state !== "ready"
              ? { reason: vectors.reason ?? "embedding_search_unavailable" }
              : {}),
          };
        },
      };
      return access;
    },
  };
}
