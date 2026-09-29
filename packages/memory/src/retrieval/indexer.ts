import { defaultRuntimeTokenCounter } from "@pragma/core";
import { z } from "zod";
import type { EpisodicMemoryStore } from "../episodic/store.ts";
import type { SemanticMemoryStore } from "../semantic/store.ts";
import { EmbeddingError, type EmbeddingProvider } from "./embedding.ts";
import { projectMemory, type RetrievalRecord, type MemorySegment } from "./projection.ts";
import type { MemoryVectorIndex } from "./vector-index.ts";

const GenerationSchema = z.object({
  status: z.string(),
  dimensions: z.number().nullable(),
  response_model: z.string().nullable(),
  cursor_episode: z.string().nullable(),
  cursor_fact: z.string().nullable(),
});
export function createMemoryIndexer(options: {
  index: MemoryVectorIndex;
  episodic: EpisodicMemoryStore;
  semantic: SemanticMemoryStore;
  getProvider: () => Promise<EmbeddingProvider | undefined>;
}) {
  let running: Promise<void> | undefined, abort: AbortController | undefined;
  let code: string | undefined;
  let issueKey: string | undefined,
    retryAt = 0,
    permanent = false,
    forceRetry = false;
  let previousPassKey: string | undefined;
  const ingest = async (
    source: RetrievalRecord,
    provider: EmbeddingProvider,
    signal: AbortSignal,
  ) => {
    const generation = provider.profile.fingerprint,
      module = source.module,
      memoryId = source.record.id,
      revision = source.record.revision;
    const store = module === "episodic" ? options.episodic : options.semantic;
    const guard = async () => {
      signal.throwIfAborted();
      if ((await options.getProvider())?.profile.fingerprint !== generation)
        throw new Error("embedding_cancelled");
      if ((await store.get(memoryId))?.revision !== revision)
        throw new Error("embedding_record_changed");
    };
    await guard();
    if (
      source.record.status !== "active" ||
      source.record.sensitivity === "restricted" ||
      (source.module === "semantic" &&
        source.record.expiresAt !== undefined &&
        Date.parse(source.record.expiresAt) <= Date.now())
    ) {
      await options.index.call("delete", { generation, module, memoryId }, signal);
      return;
    }
    let cap = provider.profile.maxInputTokens;
    for (;;) {
      const segments = projectMemory(source, cap);
      const hashes = z
        .array(z.object({ textHash: z.string() }))
        .parse(await options.index.call("hashes", { generation, module, memoryId }, signal));
      const retained = new Set(hashes.map((value) => value.textHash));
      const rows: Array<MemorySegment & { vector?: Float32Array }> = segments.map((segment) => ({
        ...segment,
      }));
      let meta = GenerationSchema.parse(
        await options.index.call("generation", { generation }, signal),
      );
      let dimensions = meta.dimensions,
        responseModel = meta.response_model;
      try {
        const missing = rows.filter((segment) => !retained.has(segment.textHash));
        for (let start = 0; start < missing.length;) {
          const batch: typeof missing = [];
          let tokens = 0;
          while (start < missing.length && batch.length < provider.profile.maxBatchInputs) {
            const next = missing[start]!;
            const count = defaultRuntimeTokenCounter.countText(next.text).tokens;
            if (batch.length > 0 && tokens + count > provider.profile.maxBatchTokens) break;
            if (count > provider.profile.maxBatchTokens)
              throw new EmbeddingError("embedding_input_too_large");
            batch.push(next);
            tokens += count;
            start++;
          }
          await guard();
          const result = await provider.embed(
            batch.map((value) => value.text),
            signal,
          );
          await guard();
          if (
            (dimensions !== null && dimensions !== result.dimensions) ||
            (responseModel !== null && responseModel !== result.model)
          )
            throw new EmbeddingError("embedding_space_changed");
          dimensions = result.dimensions;
          responseModel = result.model;
          batch.forEach((segment, i) => {
            segment.vector = result.vectors[i]!;
          });
        }
        // Empty projections do not establish a vector space.
        if (rows.length === 0) {
          await options.index.call("delete", { generation, module, memoryId }, signal);
          return;
        }
        await guard();
        meta = GenerationSchema.parse(
          await options.index.call("generation", { generation }, signal),
        );
        await options.index.call(
          "replace",
          {
            generation,
            module,
            memoryId,
            revision,
            ...(source.module === "semantic" && source.record.expiresAt !== undefined
              ? { expiresAt: source.record.expiresAt }
              : {}),
            segments: rows.map(({ text, ...segment }) => {
              void text;
              return segment;
            }),
            dimensions: dimensions ?? meta.dimensions,
            responseModel: responseModel ?? meta.response_model,
          },
          signal,
        );
        return;
      } catch (error) {
        if (
          error instanceof EmbeddingError &&
          error.code === "embedding_input_too_large" &&
          cap > 64
        ) {
          cap = Math.floor(cap / 2);
          continue;
        }
        throw error;
      }
    }
  };
  const run = async (signal: AbortSignal) => {
    // Removal is local cache maintenance and must not depend on provider health,
    // retry backoff, or whether embedding requests are currently enabled.
    await options.index.call("expire", { now: new Date().toISOString() }, signal);
    for (const module of ["episodic", "semantic"] as const) {
      const store = module === "episodic" ? options.episodic : options.semantic;
      for (;;) {
        signal.throwIfAborted();
        const changes = await store.readIndexRemovals(100);
        if (changes.length === 0) break;
        for (const change of changes) {
          await options.index.call(
            "delete",
            { module, memoryId: change.memoryId, allGenerations: true },
            signal,
          );
          await store.acknowledgeIndexChange(change);
        }
      }
    }
    const provider = await options.getProvider();
    if (provider === undefined) return;
    const generation = provider.profile.fingerprint;
    const passKey = `${generation}:${provider.retryKey ?? ""}`;
    if (!forceRetry && issueKey === passKey && (permanent || Date.now() < retryAt)) return;
    code = undefined;
    permanent = false;
    const retryFailures = forceRetry || previousPassKey !== passKey;
    previousPassKey = passKey;
    forceRetry = false;
    issueKey = passKey;
    await options.index.call("ensure", { profile: provider.profile }, signal);
    const meta = GenerationSchema.parse(
      await options.index.call("generation", { generation }, signal),
    );
    const process = async (module: "episodic" | "semantic", id: string) => {
      const source: RetrievalRecord | undefined =
        module === "episodic"
          ? await options.episodic
              .get(id)
              .then((record) => (record === undefined ? undefined : { module, record }))
          : await options.semantic
              .get(id)
              .then((record) => (record === undefined ? undefined : { module, record }));
      const record = source?.record;
      if (record === undefined) {
        await options.index.call("delete", { generation, module, memoryId: id }, signal);
        return;
      }
      try {
        await ingest(source!, provider, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const message =
          error instanceof Error && /^embedding_[a-z_]+$/u.test(error.message)
            ? error.message
            : "embedding_index_unavailable";
        if (message === "embedding_cancelled" || message === "embedding_record_changed")
          throw error;
        code = message;
        await options.index.call(
          "failure",
          { generation, module, memoryId: id, revision: record.revision, code: message },
          signal,
        );
        // Retryable transport/auth errors stop this pass. Work remains in the outbox or backfill cursor.
        if (
          message !== "embedding_input_too_large" &&
          message !== "embedding_input_limit_too_small"
        )
          throw error;
      }
    };
    for (const module of ["episodic", "semantic"] as const) {
      const store = module === "episodic" ? options.episodic : options.semantic;
      if (meta.status !== "ready") {
        let cursor = (module === "episodic" ? meta.cursor_episode : meta.cursor_fact) ?? undefined;
        for (;;) {
          signal.throwIfAborted();
          const records = await store.scanForIndex(cursor, 100);
          if (records.length === 0) break;
          for (const record of records) {
            await process(module, record.id);
            cursor = record.id;
            await options.index.call("cursor", { generation, module, memoryId: cursor }, signal);
          }
        }
      }
      // Durable failures are retried on a new pass; never clear them before successful replacement.
      const failures = z
        .array(z.object({ memoryId: z.string() }))
        .parse(await options.index.call("failed", { generation, module }, signal));
      if (retryFailures) for (const failed of failures) await process(module, failed.memoryId);
      for (;;) {
        const changes = await store.readIndexChanges(100);
        if (changes.length === 0) break;
        for (const change of changes) {
          await process(module, change.memoryId);
          await store.acknowledgeIndexChange(change);
        }
      }
    }
    // Re-read both outboxes after replay so a write during the other module's backfill cannot be missed.
    if (
      (await options.episodic.readIndexChanges(1)).length ||
      (await options.semantic.readIndexChanges(1)).length
    )
      return;
    if ((await options.getProvider())?.profile.fingerprint !== generation)
      throw new Error("embedding_cancelled");
    await options.index.call("activate", { generation }, signal);
  };
  return {
    get errorCode() {
      return code;
    },
    async tick(force = false) {
      if (force) forceRetry = true;
      if (running !== undefined) return await running;
      abort = new AbortController();
      running = run(abort.signal)
        .catch((error) => {
          if (!abort?.signal.aborted) {
            code =
              error instanceof Error && /^embedding_[a-z_]+$/u.test(error.message)
                ? error.message
                : "embedding_index_unavailable";
            permanent = [
              "embedding_auth_invalid",
              "embedding_request_invalid",
              "embedding_response_invalid",
              "embedding_space_changed",
            ].includes(code);
            retryAt = Date.now() + 30_000;
          }
        })
        .finally(() => {
          running = undefined;
          abort = undefined;
        });
      await running;
    },
    cancel() {
      abort?.abort();
    },
    async stop() {
      abort?.abort();
      await running;
    },
  };
}
