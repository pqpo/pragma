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
