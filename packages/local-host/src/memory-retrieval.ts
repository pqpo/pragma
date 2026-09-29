import { access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PragmaPaths, withFileLock, type ExpertAgentContextItemSearchMatch } from "@pragma/core";
import {
  BoundedLruCache,
  MemoryRetrievalStatusSchema,
  type MemoryRetrievalStatus,
} from "@pragma/shared";
import {
  createMemoryVectorIndex,
  createMemoryIndexer,
  createOpenAIEmbeddingProvider,
  selectedMemoryText,
  projectionHash,
  redactMemoryProjection,
  type EmbeddingProvider,
  type MemoryVectorIndex,
  type MemoryRecallScope,
  type MemoryAttentionCandidate,
} from "@pragma/memory";
import { z } from "zod";
import { createModelProviderReader } from "./model-providers/reader.ts";
import { createMemoryRetrievalSettingsStore } from "./memory-retrieval-settings.ts";
import { createMemoryAttentionRequestLimiter } from "./memory-attention-request-limiter.ts";
import type { SecretStore } from "./secrets/secret-store.ts";
import type { createLocalHostMemoryDataPlane } from "./memory-data-plane.ts";
export function createLocalHostMemoryRetrieval(options: {
  pragmaHome: string;
  data: Awaited<ReturnType<typeof createLocalHostMemoryDataPlane>>;
  secrets: SecretStore;
  fetch?: typeof fetch;
  backgroundIndexing?: boolean;
  requestLimiter?: ReturnType<typeof createMemoryAttentionRequestLimiter>;
  onDiagnostic?: ((code: string | undefined) => void) | undefined;
}) {
  const paths = new PragmaPaths(options),
    settings = createMemoryRetrievalSettingsStore(options);
  const reader = createModelProviderReader({
    configPath: paths.modelProviders(),
    secretStore: options.secrets,
  });
  const limitRequests = options.requestLimiter ?? createMemoryAttentionRequestLimiter();
  const admit = (provider: EmbeddingProvider): EmbeddingProvider => ({
    ...provider,
    embed: (texts, signal) => limitRequests(signal, () => provider.embed(texts, signal)),
    validate: (signal) => limitRequests(signal, () => provider.validate(signal)),
  });
  let index: MemoryVectorIndex | undefined,
    indexer: ReturnType<typeof createMemoryIndexer> | undefined,
    closed = false,
    rebuilding = false,
    errorCode: string | undefined,
    queryErrorCode: string | undefined;
  let pendingIndex: Promise<MemoryVectorIndex> | undefined;
  let abort = new AbortController();
  let ticking: Promise<void> | undefined;
  const queryCache = new BoundedLruCache<
    string,
    { vector: Float32Array; model: string; dimensions: number }
  >(32);
  const getProvider = async (): Promise<EmbeddingProvider | undefined> => {
    const selected = await settings.get();
    if (
      !selected.enabled ||
      closed ||
      (await options.data.policies.getGlobal()).policy.enabled !== "enabled"
    )
      return undefined;
    const resolved = await reader.resolveEmbedding(selected.providerId!, selected.modelId!);
    const model = resolved.model;
    const baseUrl = (model.baseUrl ?? resolved.provider.baseUrl).replace(/\/+$/u, "");
    const identity = {
      providerId: selected.providerId!,
      modelId: model.id,
      baseUrl,
      maxInputTokens: model.maxInputTokens!,
      maxBatchInputs: model.maxBatchInputs,
      maxBatchTokens: model.maxBatchTokens ?? model.maxInputTokens!,
      projectionVersion: 1 as const,
    };
    const profile = {
      ...identity,
      fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    };
    const embedding = createOpenAIEmbeddingProvider({
      profile,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      getApiKey: async () => {
        const current = await settings.get();
        if (
          !current.enabled ||
          current.providerId !== selected.providerId ||
          current.modelId !== selected.modelId
        )
          throw new Error("embedding_cancelled");
        const live = await reader.resolveEmbedding(selected.providerId!, selected.modelId!);
        if ((live.model.baseUrl ?? live.provider.baseUrl).replace(/\/+$/u, "") !== baseUrl)
          throw new Error("embedding_cancelled");
        return live.provider.apiKey;
      },
      beforeRequest: async () => {
        if (
          closed ||
          !(await settings.get()).enabled ||
          (await options.data.policies.getGlobal()).policy.enabled !== "enabled"
        )
          throw new Error("embedding_cancelled");
      },
    });
    return Object.assign(admit(embedding), {
      retryKey: `${resolved.revision}:${resolved.provider.credentialFingerprint}`,
    });
  };
  const getIndex = async () => {
    if (index !== undefined) return index;
    pendingIndex ??= createMemoryVectorIndex({
      path: paths.memoryVectorIndex(),
      readOnly: !options.backgroundIndexing,
    })
      .then((value) => {
        index = value;
        return value;
      })
      .catch((error) => {
        pendingIndex = undefined;
        throw error;
      });
    return await pendingIndex;
  };
  const report = (error: unknown, query = false) => {
    const code =
      error instanceof Error && /^embedding_[a-z_]+$/u.test(error.message)
        ? error.message
        : "embedding_index_unavailable";
    if (query) queryErrorCode = code;
    else errorCode = code;
    options.onDiagnostic?.(queryErrorCode ?? errorCode);
  };
  const vectorSearch = async (
    scope: MemoryRecallScope,
    query: string,
    modules: readonly ("episodic" | "semantic")[],
    limit: number,
    signal: AbortSignal,
  ): Promise<MemoryAttentionCandidate[]> => {
    const desired = await getProvider();
    if (desired === undefined) return [];
    const cache = await getIndex(),
      binding = await cache.binding();
    if (
      binding === undefined ||
      binding.profile.baseUrl !== desired.profile.baseUrl ||
      binding.profile.providerId !== desired.profile.providerId
    )
      return [];
    // Same endpoint model replacement can keep the old complete generation until activation.
    const provider = admit(
      createOpenAIEmbeddingProvider({
        profile: binding.profile,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        getApiKey: async () => {
          const live = await getProvider();
          if (
            live === undefined ||
            live.profile.baseUrl !== binding.profile.baseUrl ||
            live.profile.providerId !== binding.profile.providerId
          )
            throw new Error("embedding_cancelled");
          return (await reader.resolveEmbedding(live.profile.providerId, live.profile.modelId))
            .provider.apiKey;
        },
      }),
    );
    const allowedByModule = new Map<
      "episodic" | "semantic",
      readonly { id: string; revision: number }[]
    >();
    for (const module of modules)
      allowedByModule.set(
        module,
        await (
          module === "episodic" ? options.data.episodic.store : options.data.semantic.store
        ).listRecallIdentities(scope, new Date()),
      );
    if ([...allowedByModule.values()].every((ids) => ids.length === 0)) return [];
    const key = createHash("sha256")
      .update(`${binding.profile.fingerprint}:${desired.retryKey ?? ""}:${query}`)
      .digest("hex");
    let embedded = queryCache.get(key);
    if (
      embedded !== undefined &&
      (embedded.dimensions !== binding.dimensions || embedded.model !== binding.responseModel)
    ) {
      queryCache.delete(key);
      embedded = undefined;
    }
    if (embedded === undefined) {
      const result = await provider.embed([query], signal);
      signal.throwIfAborted();
      embedded = { vector: result.vectors[0]!, model: result.model, dimensions: result.dimensions };
      queryCache.set(key, embedded);
    }
    if (embedded.dimensions !== binding.dimensions || embedded.model !== binding.responseModel)
      throw new Error("embedding_space_changed");
    const result: MemoryAttentionCandidate[] = [];
    for (const module of modules) {
      const store =
        module === "episodic" ? options.data.episodic.store : options.data.semantic.store;
      const allowed = allowedByModule.get(module) ?? [];
      const hits = await cache.search(
        {
          generation: binding.profile.fingerprint,
          module,
          vector: embedded.vector,
          allowed,
          limit: Math.min(limit * 4, 120),
        },
        signal,
      );
      const seen = new Set<string>();
      for (const hit of hits) {
        if (seen.has(hit.memoryId)) continue;
        const record = await store.peekForRecall(scope, hit.memoryId, new Date());
        if (
          record === undefined ||
          record.revision !== hit.revision ||
          record.sensitivity === "restricted"
        )
          continue;
        const source =
          module === "episodic"
            ? {
                module,
                record: await options.data.episodic.store.peekForRecall(scope, hit.memoryId),
              }
            : {
                module,
                record: await options.data.semantic.store.peekForRecall(scope, hit.memoryId),
              };
        if (
          source.record === undefined ||
          source.record.revision !== hit.revision ||
          source.record.sensitivity === "restricted"
        )
          continue;
        const summary =
          source.module === "episodic"
            ? selectedMemoryText(
                {
                  module: "episodic",
                  record: source.record as import("@pragma/memory").EpisodicMemoryRecord,
                },
                hit.fieldPath,
                hit.start,
                hit.end,
              )
            : selectedMemoryText(
                {
                  module: "semantic",
                  record: source.record as import("@pragma/shared").SemanticFact,
                },
                hit.fieldPath,
                hit.start,
                hit.end,
              );
        if (summary === undefined || projectionHash(summary) !== hit.textHash) continue;
        seen.add(hit.memoryId);
        result.push({
          module,
          memoryId: hit.memoryId,
          revision: hit.revision,
          title:
            module === "episodic"
              ? (record as import("@pragma/memory").EpisodicMemoryRecord).goal.text
              : (record as import("@pragma/shared").SemanticFact).statement,
          summary,
          similarity: hit.similarity,
          selectedPaths: [
            { fieldPath: hit.fieldPath, start: hit.start, end: hit.end, textHash: hit.textHash },
          ],
        });
      }
    }
    const live = await getProvider();
    if (
      live === undefined ||
      live.profile.baseUrl !== binding.profile.baseUrl ||
      live.profile.providerId !== binding.profile.providerId
    )
      return [];
    const validated: MemoryAttentionCandidate[] = [];
    for (const candidate of result) {
      const store =
        candidate.module === "episodic" ? options.data.episodic.store : options.data.semantic.store;
      const record = await store.peekForRecall(scope, candidate.memoryId, new Date());
      if (record?.revision === candidate.revision && record.sensitivity !== "restricted")
        validated.push(candidate);
    }
    return validated
      .toSorted(
        (a, b) => (b.similarity ?? 0) - (a.similarity ?? 0) || a.memoryId.localeCompare(b.memoryId),
      )
      .slice(0, limit);
  };
  return {
    async bindingRevision() {
      const current = await settings.get();
      if (!current.enabled) return String(current.revision);
      try {
        const provider = (await reader.read()).providers.find(
          (value) => value.id === current.providerId,
        );
        return `${current.revision}:${provider?.revision ?? "unavailable"}`;
      } catch {
        return `${current.revision}:unavailable`;
      }
    },
    settings: {
      ...settings,
      async update(input: Parameters<typeof settings.update>[0]) {
        if (input.enabled) {
          if (input.providerId === undefined || input.modelId === undefined)
            throw new Error("embedding_model_unavailable");
          await reader.resolveEmbedding(input.providerId, input.modelId);
        }
        return await settings.update(input);
      },
    },
    async candidates(
      scope: MemoryRecallScope,
      query: string,
      modules: readonly ("episodic" | "semantic")[],
      limit = 30,
      signal = AbortSignal.timeout(3_000),
    ) {
      const combinedSignal = AbortSignal.any([signal, abort.signal]);
      try {
        const result = await vectorSearch(
          scope,
          redactMemoryProjection(query),
          modules,
          limit,
          combinedSignal,
        );
        if (queryErrorCode !== undefined) {
          queryErrorCode = undefined;
          options.onDiagnostic?.(errorCode);
        }
        return result;
      } catch (error) {
        if (!combinedSignal.aborted) report(error, true);
        return [];
      }
    },
    async search(
      scope: MemoryRecallScope,
      query: string,
      limit: number,
    ): Promise<ExpertAgentContextItemSearchMatch[]> {
      const candidates = await this.candidates(scope, query, ["episodic", "semantic"], limit);
      return candidates.map((candidate) => ({
        id: `${candidate.module}/items/${candidate.memoryId}.md`,
        matchType: "content" as const,
        line: candidate.summary,
      }));
    },
    async validate() {
      const provider = await getProvider();
      if (provider === undefined) throw new Error("embedding_model_unavailable");
      return await provider.validate(AbortSignal.timeout(10_000));
    },
    async tick(forceRetry = false) {
      if (!options.backgroundIndexing || rebuilding) return;
      if (ticking !== undefined) return await ticking;
      ticking = (async () => {
        try {
          // Existing cache removals must run even when embedding is disabled or
          // credentials are unavailable. Do not create a cache in that case.
          try {
            await access(paths.memoryVectorIndex());
          } catch {
            if ((await getProvider()) === undefined) return;
          }
          await withFileLock(`${paths.memoryVectorIndex()}.lock`, async () => {
            const cache = await getIndex();
            indexer ??= createMemoryIndexer({
              index: cache,
              episodic: options.data.episodic.store,
              semantic: options.data.semantic.store,
              getProvider,
            });
            await indexer.tick(forceRetry);
            errorCode = indexer.errorCode;
            options.onDiagnostic?.(queryErrorCode ?? errorCode);
          });
        } catch (error) {
          report(error);
        }
      })().finally(() => {
        ticking = undefined;
      });
      await ticking;
    },
    async retry() {
      errorCode = undefined;
      void this.tick(true);
    },
    async rebuild() {
      if (rebuilding) return;
      rebuilding = true;
      try {
        abort.abort();
        await indexer?.stop();
        await ticking;
        await indexer?.stop();
        indexer = undefined;
        abort = new AbortController();
        const provider = await getProvider();
        if (provider === undefined) return;
        const cache = await getIndex();
        await withFileLock(
          `${paths.memoryVectorIndex()}.lock`,
          async () => await cache.call("reset", { generation: provider.profile.fingerprint }),
        );
        errorCode = undefined;
        queryErrorCode = undefined;
        options.onDiagnostic?.(undefined);
      } finally {
        rebuilding = false;
      }
      void this.tick(true);
    },
    async status(): Promise<MemoryRetrievalStatus> {
      const selected = await settings.get();
      let provider: EmbeddingProvider | undefined;
      try {
        provider = await getProvider();
      } catch (error) {
        report(error);
      }
      let active: string | undefined;
      let stats = { segments: 0, memories: 0, failed: 0 };
      try {
        if (selected.enabled) {
          const cache = await getIndex();
          active = (await cache.binding())?.profile.fingerprint;
          if (provider !== undefined)
            stats = z
              .object({ segments: z.number(), memories: z.number(), failed: z.number() })
              .parse(await cache.call("stats", { generation: provider.profile.fingerprint }));
        }
      } catch (error) {
        try {
          await access(paths.memoryVectorIndex());
          report(error);
        } catch {
          /* The cache has not been created yet. */
        }
      }
      const total =
        (await options.data.episodic.store.countIndexableRecords()) +
        (await options.data.semantic.store.countIndexableRecords());
      const diagnostic = queryErrorCode ?? errorCode;
      return MemoryRetrievalStatusSchema.parse({
        settings: selected,
        state: !selected.enabled
          ? "disabled"
          : diagnostic !== undefined
            ? "degraded"
            : stats.failed > 0
              ? "needs_attention"
              : provider !== undefined &&
                  (active === provider.profile.fingerprint || (total === 0 && stats.failed === 0))
                ? "ready"
                : "building",
        generation: provider?.profile.fingerprint,
        activeGeneration: active,
        segments: stats.segments,
        indexedMemories: stats.memories,
        totalMemories: total,
        failed: stats.failed,
        ...(diagnostic === undefined ? {} : { errorCode: diagnostic }),
      });
    },
    cancel() {
      abort.abort();
      indexer?.cancel();
      abort = new AbortController();
    },
    async stop() {
      closed = true;
      abort.abort();
      await indexer?.stop();
      await ticking;
      if (pendingIndex !== undefined) await pendingIndex.catch(() => undefined);
      await index?.close();
    },
  };
}
