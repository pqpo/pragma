import { createHash } from "node:crypto";
import { z } from "zod";
import type { MemorySubjectRef } from "@pragma/shared";
import type { SemanticMemoryStore } from "../semantic/store.ts";
import type { EpisodicMemoryStore } from "../episodic/store.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";
import type { RetrievalRecord } from "./projection.ts";
import type { ExtractionRecallFilter } from "./extraction-query.ts";
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
  filter?: ExtractionRecallFilter,
) => Promise<ExtractionVectorResult>;
export interface ExtractionMemoryAccess {
  intersect(others: readonly ExtractionMemoryAccess[]): ExtractionMemoryAccess;
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
  semantic: Pick<SemanticMemoryStore, "queryForExtraction" | "peekForRecall">;
  episodic: Pick<EpisodicMemoryStore, "queryForExtraction" | "peekForRecall">;
  assertAccess: (
    scope: MemoryRecallScope,
    producerRefs: readonly MemorySubjectRef[],
  ) => Promise<void>;
  vectorSearch?: ExtractionVectorSearch | undefined;
  now?: (() => Date) | undefined;
}): ExtractionMemoryReader {
  const now = options.now ?? (() => new Date());
  type Binding = {
    scope: MemoryRecallScope;
    subjects: readonly MemorySubjectRef[];
    producerRefs: readonly MemorySubjectRef[];
    recallAllowed: boolean;
  };
  const bindingsByAccess = new WeakMap<ExtractionMemoryAccess, readonly Binding[]>();
  const createAccess = (bindings: readonly Binding[]): ExtractionMemoryAccess => {
    const primary = bindings[0]!;
    const subjects = primary.subjects.filter((ref) =>
      bindings.every((binding) =>
        binding.subjects.some((candidate) => refKey(candidate) === refKey(ref)),
      ),
    );
    const allowed = new Set(subjects.map(refKey));
    const filter: ExtractionRecallFilter = {
      scopes: bindings.map((binding) => binding.scope),
      subjects,
    };
    const assertAccess = async () => {
      for (const binding of bindings) {
        if (!binding.recallAllowed) throw new Error("memory_curator_recall_denied");
        await options.assertAccess(binding.scope, binding.producerRefs);
      }
    };
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
        .update(JSON.stringify([filter, bindings.map((binding) => binding.producerRefs)]))
        .digest("hex"),
      intersect(others) {
        return createAccess([
          ...bindings,
          ...others.flatMap((other) => {
            const source = bindingsByAccess.get(other);
            if (source === undefined)
              throw new Error("memory_curator_scope_intersection_unavailable");
            return source;
          }),
        ]);
      },
      async list(type) {
        await assertAccess();
        const items: ExtractionMemoryRecord[] = [];
        if (type !== "episodic")
          for (const record of await options.semantic.queryForExtraction({ filter }, now()))
            items.push({ module: "semantic", record });
        if (type !== "semantic")
          for (const record of await options.episodic.queryForExtraction({ filter }, now()))
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
        let memory: ExtractionMemoryRecord | undefined;
        for (const binding of bindings) {
          if (ref.module === "semantic") {
            const record = await options.semantic.peekForRecall(binding.scope, ref.id, now());
            if (record === undefined || record.revision !== ref.revision) return undefined;
            memory = { module: "semantic", record };
          } else {
            const record = await options.episodic.peekForRecall(binding.scope, ref.id, now());
            if (record === undefined || record.revision !== ref.revision) return undefined;
            memory = { module: "episodic", record };
          }
        }
        await assertAccess();
        return memory !== undefined && permitted(memory) ? memory : undefined;
      },
      async search(input) {
        await assertAccess();
        input.signal?.throwIfAborted();
        const limit = Math.max(1, Math.min(20, Math.trunc(input.limit)));
        const candidateLimit = Math.min(limit * 4, 80);
        let vectors: ExtractionVectorResult = {
          state: "disabled",
          hits: [],
          reason: "embedding_disabled",
        };
        if (input.mode !== "keyword" && options.vectorSearch !== undefined) {
          try {
            vectors = await options.vectorSearch(
              primary.scope,
              input.query,
              input.type === "all" ? ["semantic", "episodic"] : [input.type],
              candidateLimit,
              input.signal ?? AbortSignal.timeout(3000),
              filter,
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
        const lexical: ExtractionMemoryRecord[] = [];
        if (input.mode !== "vector") {
          const query = { filter, query: input.query.trim(), limit: candidateLimit };
          if (input.type !== "episodic")
            for (const record of await options.semantic.queryForExtraction(query, now()))
              lexical.push({ module: "semantic", record });
          input.signal?.throwIfAborted();
          if (input.type !== "semantic")
            for (const record of await options.episodic.queryForExtraction(query, now()))
              lexical.push({ module: "episodic", record });
        }
        lexical.sort((a, b) => memoryKey(a).localeCompare(memoryKey(b)));
        const vectorItems: ExtractionMemoryRecord[] = [];
        for (const hit of vectors.hits
          .filter((hit) => input.type === "all" || hit.module === input.type)
          .slice(0, candidateLimit)) {
          input.signal?.throwIfAborted();
          const current = await access.get(
            extractionMemoryRef(hit.module, hit.memoryId, hit.revision),
          );
          if (current !== undefined) vectorItems.push(current);
        }
        const lexicalKeys = new Set(lexical.map(memoryKey)),
          vectorKeys = new Set(vectorItems.map(memoryKey));
        const result = [];
        for (const item of fuseMemoryRanks(
          [lexical.filter(permitted), vectorItems],
          memoryKey,
        ).slice(0, limit)) {
          input.signal?.throwIfAborted();
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
    bindingsByAccess.set(access, bindings);
    return access;
  };
  return {
    bind(scope, subjects, recallAllowed = true, producerRefs = []) {
      return createAccess([
        {
          scope: structuredClone(scope),
          subjects: structuredClone(subjects),
          recallAllowed,
          producerRefs: structuredClone(producerRefs),
        },
      ]);
    },
  };
}
