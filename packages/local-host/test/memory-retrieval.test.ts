import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PragmaPaths } from "@pragma/core";
import * as memory from "@pragma/memory";
import { createEpisodicMemoryStore, createSemanticMemoryStore } from "@pragma/memory";
import { createLocalHostMemoryRetrieval } from "../src/memory-retrieval.ts";
import { createSecretStore, type OsKeychain } from "../src/secrets/secret-store.ts";
import type { createLocalHostMemoryDataPlane } from "../src/memory-data-plane.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-retrieval-host-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  const historical = (name: string) =>
    new URL(`../../memory/test/fixtures/retrieval/${name}`, import.meta.url);
  for (const [module, file] of [
    ["episodic", "episodes.sqlite"],
    ["semantic", "facts.sqlite"],
  ] as const) {
    const dir = paths.memoryModuleDataRoot(`pragma.memory.${module}`);
    await mkdir(dir, { recursive: true });
    await copyFile(historical(`${module}-data.sqlite`), join(dir, file));
  }
  const episodic = await createEpisodicMemoryStore({ pragmaHome: root }),
    semantic = await createSemanticMemoryStore({ pragmaHome: root });
  let enabled = true;
  let recall = true;
  const resolveAt = vi.fn(async () => ({ recall: enabled && recall }));
  const data = {
    episodic: { store: episodic },
    semantic: { store: semantic },
    policies: {
      getGlobal: async () => ({ policy: { enabled: enabled ? "enabled" : "disabled" } }),
      resolveAt,
    },
  } as unknown as Awaited<ReturnType<typeof createLocalHostMemoryDataPlane>>;
  const keys = new Map<string, Uint8Array>();
  const keychain: OsKeychain = {
    inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
    get: async (service, account) => keys.get(`${service}:${account}`) ?? null,
    set: async (service, account, value) => {
      keys.set(`${service}:${account}`, value);
    },
    delete: async (service, account) => {
      keys.delete(`${service}:${account}`);
    },
  };
  const secrets = createSecretStore({
    root: paths.secretStoreRoot(),
    dataRoot: paths.dataRoot(),
    keychain,
  });
  const config = JSON.parse(await readFile(historical("model-providers-v6.json"), "utf8"));
  config.schemaVersion = 7;
  const provider = config.providers[0];
  provider.models = [
    {
      kind: "embedding",
      id: "embedding",
      name: "Embedding",
      api: "openai-embeddings",
      maxInputTokens: 1024,
      maxInputTokensSource: "manual",
      maxBatchInputs: 8,
      maxBatchTokens: 8192,
      cost: { input: 0 },
      capabilitiesSource: "manual",
    },
  ];
  provider.apiKeySecretRef = await secrets.put({
    owner: { kind: "model-provider", providerId: provider.id },
    value: new TextEncoder().encode("synthetic-embedding-key"),
  });
  await writeFile(paths.modelProviders(), JSON.stringify(config));
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    return Response.json({
      model: request.model,
      data: request.input.map((_: unknown, index: number) => ({ index, embedding: [1, 0] })),
    });
  });
  const options = { pragmaHome: root, data, secrets, fetch: fetcher };
  const desktop = createLocalHostMemoryRetrieval({ ...options, backgroundIndexing: true });
  await desktop.settings.update({
    expectedRevision: 0,
    enabled: true,
    providerId: provider.id,
    modelId: "embedding",
  });
  return {
    root,
    paths,
    episodic,
    semantic,
    desktop,
    config,
    provider,
    fetcher,
    options,
    resolveAt,
    revokeRecall: () => {
      recall = false;
    },
    disable: () => {
      enabled = false;
    },
  };
}
describe("Memory retrieval across Hosts", () => {
  it("searches the management catalog across owners while Agent recall stays scoped", async () => {
    const f = await fixture();
    try {
      await f.desktop.tick();
      const hits = await f.desktop.searchCatalog("an unrelated paraphrase", ["semantic"], 30);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.module === "semantic")).toBe(true);
      expect(new Set(hits.map((hit) => hit.memoryId)).size).toBe(hits.length);
      expect(
        await f.desktop.search(
          { rootRef: { type: "pragma.expert", id: "unrelated-owner" } },
          "an unrelated paraphrase",
          30,
        ),
      ).toEqual([]);
      expect(f.resolveAt).not.toHaveBeenCalled();
      const stale = hits[0]!;
      const get = f.semantic.get.bind(f.semantic);
      const changed = vi.spyOn(f.semantic, "get").mockImplementation(async (id) => {
        const record = await get(id);
        return id === stale.memoryId && record !== undefined
          ? { ...record, revision: record.revision + 1 }
          : record;
      });
      expect(
        (await f.desktop.searchCatalog("an unrelated paraphrase", ["semantic"], 30)).some(
          (hit) => hit.memoryId === stale.memoryId,
        ),
      ).toBe(false);
      changed.mockRestore();
      f.disable();
      expect(await f.desktop.searchCatalog("paraphrase", ["semantic"], 30)).toEqual([]);
    } finally {
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });

  it("keeps catalog candidates beyond the Agent recall window available for paging", async () => {
    const f = await fixture();
    const db = new DatabaseSync(
      join(f.paths.memoryModuleDataRoot("pragma.memory.semantic"), "facts.sqlite"),
    );
    try {
      const original = (
        await f.semantic.listCandidatesForRecall(
          { rootRef: { type: "pragma.expert", id: "expert-a" } },
          new Date(),
        )
      )[0]!;
      const insert = db.prepare(
        "INSERT INTO current_facts(id,revision,status,updated_at,record_json) VALUES(?,?,?,?,?)",
      );
      for (let index = 0; index < 145; index++) {
        const record = { ...original, id: `fact-${index.toString(16).padStart(24, "0")}` };
        insert.run(
          record.id,
          record.revision,
          record.status,
          record.updatedAt,
          JSON.stringify(record),
        );
      }
      await f.desktop.tick();
      const hits = await f.desktop.searchCatalog(
        "a paraphrase without keyword overlap",
        ["semantic"],
        200,
      );
      expect(hits.length).toBeGreaterThanOrEqual(145);
      expect(new Set(hits.map((hit) => hit.memoryId)).size).toBe(hits.length);
    } finally {
      db.close();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
    // Builds 145 records through the production vector Worker; this is a bulk integration case.
  }, 15_000);

  it("applies the extraction scope intersection before the vector index Top-K cutoff", async () => {
    const f = await fixture();
    const a = { rootRef: { type: "pragma.expert", id: "expert-a" } };
    const b = { rootRef: { type: "pragma.expert", id: "expert-b" } };
    const commonId = "fact-ffffffffffffffffffffffff";
    const db = new DatabaseSync(
      join(f.paths.memoryModuleDataRoot("pragma.memory.semantic"), "facts.sqlite"),
    );
    try {
      const original = (await f.semantic.listCandidatesForRecall(a, new Date()))[0]!;
      const insert = db.prepare(
        "INSERT INTO current_facts(id,revision,status,updated_at,record_json) VALUES(?,?,?,?,?)",
      );
      for (let index = 0; index < 12; index++) {
        const record = { ...original, id: `fact-${index.toString(16).padStart(24, "0")}` };
        insert.run(
          record.id,
          record.revision,
          record.status,
          record.updatedAt,
          JSON.stringify(record),
        );
      }
      const common = {
        ...original,
        id: commonId,
        bindings: [...original.bindings, { ...original.bindings[0]!, consumerRef: b.rootRef }],
      };
      insert.run(
        common.id,
        common.revision,
        common.status,
        common.updatedAt,
        JSON.stringify(common),
      );
      await f.desktop.tick();
      const identities = vi.spyOn(f.semantic, "listExtractionIdentities");
      const reader = memory.createExtractionMemoryReader({
        semantic: f.semantic,
        episodic: f.episodic,
        assertAccess: async () => {},
        vectorSearch: f.desktop.searchForExtraction,
      });
      const subjects = [{ type: "pragma.user", id: "local-user" }];
      const bound = reader.bind(a, subjects).intersect([reader.bind(b, subjects)]);
      const result = await bound.search({
        query: "Chinese",
        type: "semantic",
        mode: "vector",
        limit: 1,
      });
      expect(result.items.map((item) => item.memory.record.id)).toEqual([commonId]);
      expect(identities).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: [a, b] }),
        expect.any(Date),
      );
    } finally {
      db.close();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("shares configured vector retrieval with extraction and returns explicit disabled-mode status", async () => {
    const f = await fixture();
    try {
      await f.desktop.tick();
      const scope = { rootRef: { type: "pragma.expert" as const, id: "expert-a" } };
      const reader = memory.createExtractionMemoryReader({
        semantic: f.semantic,
        episodic: f.episodic,
        assertAccess: async () => {
          if (!(await f.resolveAt()).recall) throw new Error("memory_curator_recall_denied");
        },
        vectorSearch: f.desktop.searchForExtraction,
      });
      const bound = reader.bind(scope, [{ type: "pragma.user", id: "local-user" }]);
      const result = await bound.search({
        query: "语言偏好",
        mode: "vector",
        type: "all",
        limit: 20,
      });
      expect(result.mode).toBe("vector");
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((item) => item.matchedBy.includes("vector"))).toBe(true);
      const [first] = result.items;
      expect(await bound.get(memory.extractionMemoryHandle(first!.memory))).toEqual(first!.memory);
      const queriesBefore = f.fetcher.mock.calls.length;
      await f.desktop.search(scope, "语言偏好", 20);
      expect(f.fetcher).toHaveBeenCalledTimes(queriesBefore); // Same embedding query cache.
      await f.desktop.settings.update({ expectedRevision: 1, enabled: false });
      expect(
        await bound.search({ query: "Chinese", mode: "hybrid", type: "semantic", limit: 10 }),
      ).toMatchObject({ mode: "keyword", reason: "embedding_disabled" });
      await expect(
        bound.search({ query: "Chinese", mode: "vector", type: "semantic", limit: 10 }),
      ).rejects.toThrow("embedding_disabled");
      f.revokeRecall();
      await expect(bound.list("all")).rejects.toThrow("recall_denied");
    } finally {
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("reports unavailable extraction retrieval when the provider changes during a query", async () => {
    const f = await fixture();
    try {
      await f.desktop.tick();
      f.fetcher.mockImplementationOnce(async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        f.provider.baseUrl = "https://another-provider.example/v1";
        f.provider.revision++;
        await writeFile(f.paths.modelProviders(), JSON.stringify(f.config));
        return Response.json({
          model: request.model,
          data: request.input.map((_: unknown, index: number) => ({ index, embedding: [1, 0] })),
        });
      });
      expect(
        await f.desktop.searchForExtraction(
          { rootRef: { type: "pragma.expert", id: "expert-a" } },
          "query while switching provider",
          ["semantic"],
          10,
          new AbortController().signal,
        ),
      ).toEqual({ state: "unavailable", hits: [], reason: "embedding_cancelled" });
    } finally {
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("reports disabled optional retrieval without a missing-model error or provider requests", async () => {
    const f = await fixture();
    try {
      await f.desktop.settings.update({ expectedRevision: 1, enabled: false });
      const status = await f.desktop.status();
      expect(status.state).toBe("disabled");
      expect(status.errorCode).toBeUndefined();
      await f.desktop.tick();
      expect(f.fetcher).not.toHaveBeenCalled();
      await expect(access(f.paths.memoryVectorIndex())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("reports an enabled setting awaiting model selection without requests or a vector cache", async () => {
    const f = await fixture();
    try {
      await f.desktop.settings.update({ expectedRevision: 1, enabled: true });
      expect(await f.desktop.status()).toMatchObject({
        state: "needs_attention",
        errorCode: "embedding_model_unavailable",
      });
      await f.desktop.tick();
      expect(
        await f.desktop.candidates(
          { rootRef: { type: "pragma.expert", id: "expert-a" } },
          "unconfigured query",
          ["episodic"],
          8,
        ),
      ).toEqual([]);
      expect(f.fetcher).not.toHaveBeenCalled();
      await expect(access(f.paths.memoryVectorIndex())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });

  it.each(["removed-model", "missing-credential"])(
    "disables retrieval when its configured binding has a %s",
    async (failure) => {
      const f = await fixture();
      try {
        if (failure === "removed-model") {
          f.provider.models[0].id = "replacement-embedding";
          f.provider.revision++;
          await writeFile(f.paths.modelProviders(), JSON.stringify(f.config));
        } else {
          const ref = f.provider.apiKeySecretRef;
          await f.options.secrets.delete(ref, ref.revision);
        }
        const getSecret = vi.spyOn(f.options.secrets, "get");
        const next = await f.desktop.settings.update({
          expectedRevision: 1,
          enabled: false,
          providerId: f.provider.id,
          modelId: "embedding",
        });
        expect(next).toMatchObject({ enabled: false, revision: 2, modelId: "embedding" });
        expect(await f.desktop.status()).toMatchObject({ state: "disabled", settings: next });
        expect(getSecret).not.toHaveBeenCalled();
        expect(f.fetcher).not.toHaveBeenCalled();
        await expect(
          f.desktop.settings.update({
            expectedRevision: next.revision,
            enabled: true,
            providerId: f.provider.id,
            modelId: "embedding",
          }),
        ).rejects.toThrow();
        expect(await f.desktop.settings.get()).toEqual(next);
      } finally {
        await f.desktop.stop();
        f.episodic.close();
        f.semantic.close();
      }
    },
  );

  it("rechecks root and expert recall after selecting records and before sending a query", async () => {
    const f = await fixture();
    const cli = createLocalHostMemoryRetrieval(f.options);
    const scope = {
      rootRef: { type: "pragma.expert-team", id: "team-a" },
      expertRef: { type: "pragma.expert", id: "expert-a" },
    } as const;
    try {
      await f.desktop.tick();
      const calls = f.fetcher.mock.calls.length;
      const list = f.episodic.listRecallIdentities.bind(f.episodic);
      const identities = vi
        .spyOn(f.episodic, "listRecallIdentities")
        .mockImplementationOnce(async () => {
          const result = await list({ rootRef: scope.expertRef }, new Date());
          expect(result).toHaveLength(1);
          f.revokeRecall();
          return result;
        });
      expect(await cli.candidates(scope, "private mission query", ["episodic"], 8)).toEqual([]);
      expect(f.fetcher).toHaveBeenCalledTimes(calls);
      expect(f.resolveAt).toHaveBeenLastCalledWith({
        rootRef: scope.rootRef,
        producerRefs: [scope.expertRef],
        occurredAt: expect.any(String),
      });
      identities.mockRestore();
    } finally {
      await cli.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("rechecks scoped recall before retrying a failed HTTP query", async () => {
    const f = await fixture();
    const cli = createLocalHostMemoryRetrieval(f.options);
    try {
      await f.desktop.tick();
      const calls = f.fetcher.mock.calls.length;
      f.fetcher.mockImplementationOnce(async () => {
        f.revokeRecall();
        return new Response("", { status: 500 });
      });
      expect(
        await cli.candidates(
          { rootRef: { type: "pragma.expert", id: "expert-a" } },
          "retry query",
          ["episodic"],
          8,
        ),
      ).toEqual([]);
      expect(f.fetcher).toHaveBeenCalledTimes(calls + 1);
    } finally {
      await cli.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("does not reopen an existing vector cache after shutdown, including status reads", async () => {
    const f = await fixture();
    const service = createLocalHostMemoryRetrieval({ ...f.options, backgroundIndexing: true });
    const open = vi.spyOn(memory, "createMemoryVectorIndex");
    try {
      await f.desktop.tick();
      await service.stop();
      open.mockClear();
      await service.tick();
      await service.status();
      await service.rebuild();
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      await service.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it.each(["disabled", "replacement_failed"])(
    "removes forgotten vectors when indexing is %s",
    async (mode) => {
      const f = await fixture();
      try {
        await f.desktop.tick();
        if (mode === "replacement_failed") {
          f.provider.models[0].id = "embedding-next";
          f.provider.revision++;
          await writeFile(f.paths.modelProviders(), JSON.stringify(f.config));
          await f.desktop.settings.update({
            expectedRevision: 1,
            enabled: true,
            providerId: f.provider.id,
            modelId: "embedding-next",
          });
          f.fetcher.mockResolvedValueOnce(new Response("", { status: 401 }));
          await f.desktop.tick();
          expect(await f.desktop.status()).toMatchObject({
            state: "degraded",
            errorCode: "embedding_auth_invalid",
          });
        }
        const [record] = await f.episodic.scanForIndex(undefined, 1);
        const [fact] = await f.semantic.scanForIndex(undefined, 1);
        await f.semantic.invalidate({
          id: fact!.id,
          expectedRevision: fact!.revision,
          actorRef: { type: "pragma.user", id: "local-user" },
          reason: "regression",
          now: new Date(),
        });
        await f.episodic.forget({
          id: record!.id,
          expectedRevision: record!.revision,
          actorRef: { type: "pragma.user", id: "local-user" },
          reason: "regression",
          now: new Date(),
        });
        const calls = f.fetcher.mock.calls.length;
        if (mode === "disabled") f.disable();
        await f.desktop.tick();
        const db = new DatabaseSync(f.paths.memoryVectorIndex(), { readOnly: true });
        try {
          expect(db.prepare("SELECT count(*) AS n FROM segments").get()).toMatchObject({ n: 0 });
        } finally {
          db.close();
        }
        expect(await f.episodic.readIndexChanges(1)).toEqual([]);
        expect(await f.semantic.readIndexChanges(1)).toEqual([]);
        expect(f.fetcher).toHaveBeenCalledTimes(calls);
      } finally {
        await f.desktop.stop();
        f.episodic.close();
        f.semantic.close();
      }
    },
  );
  it("rebuilds after a permanent failure without requiring a provider configuration change", async () => {
    const f = await fixture();
    try {
      f.fetcher.mockResolvedValueOnce(new Response("", { status: 401 }));
      await f.desktop.tick();
      expect(await f.desktop.status()).toMatchObject({
        state: "degraded",
        errorCode: "embedding_auth_invalid",
      });
      await f.desktop.rebuild();
      await f.desktop.tick();
      expect(await f.desktop.status()).toMatchObject({ state: "ready", indexedMemories: 2 });
    } finally {
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("clears a recovered query failure in a read-only Host", async () => {
    const f = await fixture();
    const cli = createLocalHostMemoryRetrieval(f.options);
    const scope = { rootRef: { type: "pragma.expert", id: "expert-a" } } as const;
    try {
      await f.desktop.tick();
      f.fetcher.mockResolvedValueOnce(new Response("", { status: 401 }));
      expect(await cli.candidates(scope, "failed query", ["episodic"], 8)).toEqual([]);
      expect(await cli.status()).toMatchObject({
        state: "degraded",
        errorCode: "embedding_auth_invalid",
      });
      expect(await cli.candidates(scope, "recovered query", ["episodic"], 8)).toHaveLength(1);
      expect(await cli.status()).toMatchObject({ state: "ready" });
    } finally {
      await cli.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("builds using encrypted provider credentials and lets CLI consume the existing index read-only", async () => {
    const f = await fixture();
    const scope = {
      rootRef: { type: "pragma.expert", id: "expert-a" },
      expertRef: { type: "pragma.expert", id: "expert-a" },
    } as const;
    const cli = createLocalHostMemoryRetrieval(f.options);
    try {
      await f.desktop.tick();
      expect(await f.desktop.status()).toMatchObject({
        state: "ready",
        indexedMemories: 2,
        failed: 0,
      });
      expect(
        f.fetcher.mock.calls.every(
          ([, options]) =>
            new Headers(options?.headers).get("Authorization") === "Bearer synthetic-embedding-key",
        ),
      ).toBe(true);
      const hits = await cli.candidates(scope, "history", ["episodic", "semantic"], 8);
      expect(hits).toHaveLength(2);
      expect(hits.every((hit) => hit.selectedPaths?.length === 1)).toBe(true);
      const before = f.fetcher.mock.calls.length;
      await cli.tick();
      expect(f.fetcher).toHaveBeenCalledTimes(before);
      expect(await readFile(f.paths.memoryRetrievalSettings(), "utf8")).not.toContain(
        "synthetic-embedding-key",
      );
      f.provider.baseUrl = "https://another-provider.example/v1";
      f.provider.revision++;
      await writeFile(f.paths.modelProviders(), JSON.stringify(f.config));
      expect(await cli.candidates(scope, "new query", ["episodic"], 8)).toEqual([]);
      expect(f.fetcher).toHaveBeenCalledTimes(before);
      f.disable();
      expect(await cli.candidates(scope, "disabled", ["episodic"], 8)).toEqual([]);
    } finally {
      await cli.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("queries the original model until a replacement generation activates even after the old catalog row is removed", async () => {
    const f = await fixture();
    const cli = createLocalHostMemoryRetrieval(f.options);
    const scope = { rootRef: { type: "pragma.expert", id: "expert-a" } } as const;
    try {
      await f.desktop.tick();
      f.provider.models[0].id = "embedding-next";
      f.provider.revision++;
      await writeFile(f.paths.modelProviders(), JSON.stringify(f.config));
      await f.desktop.settings.update({
        expectedRevision: 1,
        enabled: true,
        providerId: f.provider.id,
        modelId: "embedding-next",
      });
      expect(await cli.candidates(scope, "replacement pending", ["episodic"], 8)).toHaveLength(1);
      expect(JSON.parse(String(f.fetcher.mock.calls.at(-1)?.[1]?.body)).model).toBe("embedding");
      await f.desktop.tick();
      expect(await cli.candidates(scope, "replacement ready", ["episodic"], 8)).toHaveLength(1);
      expect(JSON.parse(String(f.fetcher.mock.calls.at(-1)?.[1]?.body)).model).toBe(
        "embedding-next",
      );
    } finally {
      await cli.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("refreshes cached query vectors after an explicit rebuild changes the reported vector space", async () => {
    const f = await fixture();
    const cli = createLocalHostMemoryRetrieval(f.options);
    const scope = { rootRef: { type: "pragma.expert", id: "expert-a" } } as const;
    try {
      await f.desktop.tick();
      expect(await cli.candidates(scope, "same query", ["episodic"], 8)).toHaveLength(1);
      f.fetcher.mockImplementation(async (_url, options) => {
        const request = JSON.parse(String(options?.body));
        return Response.json({
          model: request.model,
          data: request.input.map((_: unknown, index: number) => ({ index, embedding: [1, 0, 0] })),
        });
      });
      await f.desktop.rebuild();
      await f.desktop.tick();
      expect(await cli.candidates(scope, "same query", ["episodic"], 8)).toHaveLength(1);
      expect(await f.desktop.status()).toMatchObject({ state: "ready", indexedMemories: 2 });
    } finally {
      await cli.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
  it("does not create a cache or call an embedding provider when CLI has no authorized records", async () => {
    const f = await fixture();
    const cli = createLocalHostMemoryRetrieval(f.options);
    try {
      await cli.tick();
      await expect(access(f.paths.memoryVectorIndex())).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.fetcher).not.toHaveBeenCalled();
      await f.desktop.tick();
      const count = f.fetcher.mock.calls.length;
      expect(
        await cli.candidates(
          { rootRef: { type: "pragma.expert", id: "denied" } },
          "private",
          ["episodic"],
          8,
        ),
      ).toEqual([]);
      expect(f.fetcher).toHaveBeenCalledTimes(count);
    } finally {
      await cli.stop();
      await f.desktop.stop();
      f.episodic.close();
      f.semantic.close();
    }
  });
});
