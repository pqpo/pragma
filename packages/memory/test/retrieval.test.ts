import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PragmaPaths, createRuntimeTokenCounter, defaultRuntimeTokenCounter } from "@pragma/core";
import {
  createEpisodicMemoryStore,
  createSemanticMemoryStore,
  EpisodicMemoryRecordSchema,
  createMemoryVectorIndex,
  createMemoryIndexer,
  createOpenAIEmbeddingProvider,
  projectMemory,
  memoryProjectionFields,
  createFileMemoryAttentionStateStore,
  MemoryAttentionStateSchema,
  type EmbeddingProvider,
  type MemoryVectorIndex,
} from "../src/index.ts";
const roots: string[] = [],
  indices: MemoryVectorIndex[] = [];
afterEach(async () => {
  await Promise.all(indices.splice(0).map((index) => index.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = (name: string) => new URL(`./fixtures/retrieval/${name}`, import.meta.url);
async function home() {
  const value = await mkdtemp(join(tmpdir(), "pragma-retrieval-"));
  roots.push(value);
  return value;
}
async function historicalStores() {
  const root = await home(),
    paths = new PragmaPaths({ pragmaHome: root });
  for (const [module, file] of [
    ["episodic", "episodes.sqlite"],
    ["semantic", "facts.sqlite"],
  ]) {
    const directory = paths.memoryModuleDataRoot(`pragma.memory.${module}`);
    await mkdir(directory, { recursive: true });
    await copyFile(fixture(`${module}-data.sqlite`), join(directory, file!));
  }
  const episodic = await createEpisodicMemoryStore({ pragmaHome: root }),
    semantic = await createSemanticMemoryStore({ pragmaHome: root });
  return { root, paths, episodic, semantic };
}
const profile = {
  fingerprint: "test-generation",
  providerId: "provider",
  modelId: "embedding",
  baseUrl: "http://localhost:9999/v1",
  maxInputTokens: 1024,
  maxBatchInputs: 8,
  maxBatchTokens: 8192,
  projectionVersion: 1 as const,
};
const embedded = (input: readonly string[]) => ({
  model: "embedding",
  dimensions: 2,
  vectors: input.map(() => new Float32Array([1, 0])),
});
describe("Memory vector retrieval", () => {
  it.each([
    { label: "ASCII", text: "x".repeat(8193), maxTokens: 1024 },
    { label: "Unicode", text: "上".repeat(8193), maxTokens: 1024 },
    {
      label: "sentence cut across estimate sources",
      text: "a_".repeat(1800) + "." + "a_".repeat(3000),
      maxTokens: 1500,
    },
  ])(
    "preserves oversized $label text and segment budgets with the warm shared counter",
    async ({ text, maxTokens }) => {
      const counter = createRuntimeTokenCounter();
      await counter.load();
      const record = EpisodicMemoryRecordSchema.parse(
        JSON.parse(await readFile(fixture("episodic-record.json"), "utf8")),
      );
      record.goal.text = text;
      const source = { module: "episodic" as const, record };
      const segments = projectMemory(source, maxTokens, counter);
      for (const field of memoryProjectionFields(source)) {
        expect(
          segments
            .filter((segment) => segment.fieldPath === field.path)
            .map((segment) => segment.text)
            .join(""),
        ).toBe(field.text);
      }
      for (const segment of segments) {
        expect(counter.countText(segment.text).tokens).toBeLessThanOrEqual(maxTokens);
      }
      counter.dispose();
    },
  );
  it("validates a model with one-input and one-token limits", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ model: "embedding", data: [{ index: 0, embedding: [1, 0] }] }),
    );
    const provider = createOpenAIEmbeddingProvider({
      profile: { ...profile, maxInputTokens: 1, maxBatchInputs: 1, maxBatchTokens: 1 },
      getApiKey: async () => "",
      fetch: fetcher,
    });
    await expect(provider.validate(AbortSignal.timeout(1000))).resolves.toEqual({
      dimensions: 2,
      model: "embedding",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports invalid endpoints before credential lookup or network retries", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const getApiKey = vi.fn(async () => "");
    for (const baseUrl of ["http://remote.example/v1", "https://remote.example/v1?key=private"]) {
      const provider = createOpenAIEmbeddingProvider({
        profile: { ...profile, baseUrl },
        getApiKey,
        fetch: fetcher,
      });
      await expect(provider.embed(["test"], AbortSignal.timeout(1000))).rejects.toThrow(
        "embedding_endpoint_invalid",
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(getApiKey).not.toHaveBeenCalled();
  });
  it("splits complete Unicode fields under the shared token limit and excludes credentials/evidence", async () => {
    const record = EpisodicMemoryRecordSchema.parse(
      JSON.parse(await readFile(fixture("episodic-record.json"), "utf8")),
    );
    record.goal.text = "寻找服务器故障原因。🌏".repeat(80);
    record.failuresAndRecoveries = [
      {
        failure: "Bearer sk-test-sensitive-token caused an authorization error",
        recovery: 'Rotate credentials: {"password":"synthetic-private-value"}',
        evidenceRefs: record.evidenceRefs,
      },
    ];
    const source = { module: "episodic" as const, record };
    const segments = projectMemory(source, 64);
    expect(segments.length).toBeGreaterThan(10);
    for (const field of memoryProjectionFields(source))
      expect(
        segments
          .filter((segment) => segment.fieldPath === field.path)
          .map((segment) => segment.text)
          .join(""),
      ).toBe(field.text);
    for (const segment of segments)
      expect(defaultRuntimeTokenCounter.countText(segment.text).tokens).toBeLessThanOrEqual(64);
    expect(JSON.stringify(segments)).not.toContain("sensitive-token");
    expect(JSON.stringify(segments)).not.toContain("synthetic-private-value");
    expect(JSON.stringify(segments)).not.toContain(record.terminalMessageId);
  });
  it("validates indexes, dimensions, finite nonzero vectors and provider usage without leaking error bodies", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "embedding",
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: [3, 0] },
        ],
        usage: { prompt_tokens: 7 },
      }),
    );
    const provider = createOpenAIEmbeddingProvider({
      profile,
      getApiKey: async () => "synthetic-key",
      fetch: fetcher,
    });
    const result = await provider.embed(["one", "two"], AbortSignal.timeout(1000));
    expect(result.inputTokens).toBe(7);
    expect([...result.vectors[0]!]).toEqual([1, 0]);
    fetcher.mockResolvedValueOnce(
      Response.json({ model: "embedding", data: [{ index: 0, embedding: [0, 0] }] }),
    );
    await expect(provider.embed(["one"], AbortSignal.timeout(1000))).rejects.toThrow(
      "embedding_response_invalid",
    );
    fetcher.mockResolvedValueOnce(new Response("private text", { status: 401 }));
    await expect(provider.embed(["one"], AbortSignal.timeout(1000))).rejects.toThrow(
      "embedding_auth_invalid",
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("filters authorization and revision before top-K, deduplicates segments and rejects vector-space changes", async () => {
    const index = await createMemoryVectorIndex({ path: join(await home(), "vectors.sqlite") });
    indices.push(index);
    await index.call("ensure", { profile });
    const insert = async (memoryId: string, revision: number, vector: Float32Array, segments = 1) =>
      index.call("replace", {
        generation: profile.fingerprint,
        module: "episodic",
        memoryId,
        revision,
        dimensions: 2,
        responseModel: "embedding",
        segments: Array.from({ length: segments }, (_, i) => ({
          segmentId: String(i),
          fieldPath: "overview",
          start: i,
          end: i + 1,
          textHash: `hash${i}`,
          vector,
        })),
      });
    await insert("denied", 1, new Float32Array([1, 0]));
    await insert("allowed", 2, new Float32Array([0.9, 0.1]), 10);
    await insert("other", 1, new Float32Array([0.8, 0.2]));
    await index.call("activate", { generation: profile.fingerprint });
    const hits = await index.search(
      {
        generation: profile.fingerprint,
        module: "episodic",
        vector: new Float32Array([1, 0]),
        allowed: [
          { id: "allowed", revision: 2 },
          { id: "other", revision: 1 },
        ],
        limit: 2,
      },
      AbortSignal.timeout(1000),
    );
    expect(hits.map((hit) => hit.memoryId)).toEqual(["allowed", "other"]);
    expect(
      await index.search(
        {
          generation: profile.fingerprint,
          module: "episodic",
          vector: new Float32Array([1, 0]),
          allowed: [{ id: "allowed", revision: 1 }],
          limit: 2,
        },
        AbortSignal.timeout(1000),
      ),
    ).toEqual([]);
    await expect(
      index.call("replace", {
        generation: profile.fingerprint,
        module: "episodic",
        memoryId: "allowed",
        revision: 3,
        dimensions: 3,
        responseModel: "embedding",
        segments: [],
      }),
    ).rejects.toThrow("embedding_space_changed");
  });
  it("removes expired semantic vectors during background maintenance without an authority mutation", async () => {
    const index = await createMemoryVectorIndex({ path: join(await home(), "vectors.sqlite") });
    indices.push(index);
    await index.call("ensure", { profile });
    await index.call("replace", {
      generation: profile.fingerprint,
      module: "semantic",
      memoryId: "expiring",
      revision: 1,
      expiresAt: "2026-09-29T00:00:00.000Z",
      dimensions: 2,
      responseModel: "embedding",
      segments: [
        {
          segmentId: "fact",
          fieldPath: "fact",
          start: 0,
          end: 1,
          textHash: "fact-hash",
          vector: new Float32Array([1, 0]),
        },
      ],
    });
    await index.call("activate", { generation: profile.fingerprint });
    await index.call("expire", { now: "2026-09-28T00:00:00.000Z" });
    expect(await index.call("stats", { generation: profile.fingerprint })).toMatchObject({
      memories: 1,
    });
    await index.call("expire", { now: "2026-09-29T00:00:00.000Z" });
    expect(await index.call("stats", { generation: profile.fingerprint })).toMatchObject({
      memories: 0,
      segments: 0,
    });
  });
  it("migrates real historical stores, resumes backfill and reuses unchanged segment hashes", async () => {
    const { paths, episodic, semantic } = await historicalStores();
    try {
      const records = await episodic.scanForIndex(undefined, 100);
      expect(records).toHaveLength(1);
      expect(await semantic.scanForIndex(undefined, 100)).toHaveLength(1);
      for (const [module, file, major] of [
        ["episodic", "episodes.sqlite", 5],
        ["semantic", "facts.sqlite", 6],
      ] as const) {
        const db = new DatabaseSync(
          join(paths.memoryModuleDataRoot(`pragma.memory.${module}`), file),
        );
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: major });
        db.close();
        expect(await readdir(paths.memoryModuleDataRoot(`pragma.memory.${module}`))).toContain(
          `${file}.v${major - 1}.backup`,
        );
      }
      const index = await createMemoryVectorIndex({ path: paths.memoryVectorIndex() });
      indices.push(index);
      const embed = vi.fn(async (input: readonly string[]) => embedded(input));
      const provider: EmbeddingProvider = {
        profile,
        embed,
        validate: async () => ({ model: "embedding", dimensions: 2 }),
      };
      const indexer = createMemoryIndexer({
        index,
        episodic,
        semantic,
        getProvider: async () => provider,
      });
      await indexer.tick();
      expect(indexer.errorCode).toBeUndefined();
      expect((await index.binding())?.profile.fingerprint).toBe(profile.fingerprint);
      const calls = embed.mock.calls.length;
      await indexer.tick();
      expect(embed).toHaveBeenCalledTimes(calls);
      const record = records[0]!;
      await episodic.tightenAccess({
        id: record.id,
        expectedRevision: record.revision,
        actorRef: { type: "pragma.user", id: "local-user" },
        reason: "Restrict exported history",
        now: new Date(),
        bindings: record.bindings.map((binding) => ({
          ...binding,
          permissionRevision: binding.permissionRevision,
        })),
      });
      expect(await episodic.readIndexChanges(1)).toHaveLength(1);
      await indexer.tick();
      expect(embed).toHaveBeenCalledTimes(calls);
      expect(await episodic.readIndexChanges(1)).toHaveLength(0);
      const revised = await episodic.get(record.id);
      await episodic.forget({
        id: record.id,
        expectedRevision: revised!.revision,
        actorRef: { type: "pragma.user", id: "local-user" },
        reason: "Forget history",
        now: new Date(),
      });
      await indexer.tick();
      expect(
        await index.call("hashes", {
          generation: profile.fingerprint,
          module: "episodic",
          memoryId: record.id,
        }),
      ).toEqual([]);
    } finally {
      episodic.close();
      semantic.close();
    }
  });
  it("migrates a real v1 attention state with backup and refuses future state/cache versions", async () => {
    const root = await home(),
      paths = new PragmaPaths({ pragmaHome: root }),
      path = paths.memoryAttentionState("historical-mission", "historical-context");
    await mkdir(dirname(path), { recursive: true });
    await copyFile(fixture("attention-v1.json"), path);
    const states = createFileMemoryAttentionStateStore({ pragmaHome: root });
    expect(await states.read("historical-mission", "historical-context")).toMatchObject({
      schemaVersion: "pragma.memory-attention/v2",
      active: [{ decisionMode: "provider", pinned: false, selectedPaths: [] }],
    });
    const before = await readFile(path, "utf8");
    await states.read("historical-mission", "historical-context");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readdir(join(dirname(path), "migrations", "backups"))).toHaveLength(1);
    const recovered = MemoryAttentionStateSchema.parse(JSON.parse(before));
    await copyFile(fixture("attention-v1.json"), path);
    const name = path.slice(dirname(path).length + 1);
    await writeFile(
      `${path}.state-migration.json`,
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.memory-attention", id: name },
        fromVersion: 1,
        toVersion: 2,
        documents: { [name]: recovered },
      }),
    );
    expect(await states.read("historical-mission", "historical-context")).toEqual(recovered);
    await writeFile(path, JSON.stringify({ schemaVersion: "pragma.memory-attention/v99" }));
    await expect(states.read("historical-mission", "historical-context")).rejects.toThrow();
    const database = join(root, "future.sqlite"),
      db = new DatabaseSync(database);
    db.exec("PRAGMA user_version=2");
    db.close();
    await expect(createMemoryVectorIndex({ path: database })).rejects.toThrow(
      "embedding_index_future_version",
    );
  });
  it("keeps failed outbox entries replayable, changes generations atomically and acknowledges only the exact outbox sequence", async () => {
    const { paths, episodic, semantic } = await historicalStores();
    const index = await createMemoryVectorIndex({ path: paths.memoryVectorIndex() });
    indices.push(index);
    let current: EmbeddingProvider = {
      profile,
      embed: async (input) => embedded(input),
      validate: async () => ({ model: "embedding", dimensions: 2 }),
    };
    const indexer = createMemoryIndexer({
      index,
      episodic,
      semantic,
      getProvider: async () => current,
    });
    try {
      await indexer.tick();
      current = {
        ...current,
        profile: { ...profile, fingerprint: "replacement", modelId: "new-model" },
        embed: async () => {
          throw new Error("embedding_auth_invalid");
        },
      };
      await indexer.tick();
      expect(indexer.errorCode).toBe("embedding_auth_invalid");
      expect((await index.binding())?.profile.fingerprint).toBe(profile.fingerprint);
      const calls = vi.fn(async (input: readonly string[]) => ({
        ...embedded(input),
        model: "new-model",
      }));
      current = { ...current, embed: calls };
      await indexer.tick();
      expect(calls).not.toHaveBeenCalled();
      await indexer.tick(true);
      expect(indexer.errorCode).toBeUndefined();
      expect((await index.binding())?.profile.fingerprint).toBe("replacement");
      const record = (await episodic.scanForIndex(undefined, 1))[0]!;
      await episodic.tightenAccess({
        id: record.id,
        expectedRevision: record.revision,
        actorRef: { type: "pragma.user", id: "local-user" },
        reason: "changed permission",
        now: new Date(),
        bindings: record.bindings,
      });
      const first = (await episodic.readIndexChanges(1))[0]!;
      const revised = (await episodic.get(record.id))!;
      await episodic.tightenAccess({
        id: record.id,
        expectedRevision: revised.revision,
        actorRef: { type: "pragma.user", id: "local-user" },
        reason: "changed again",
        now: new Date(),
        bindings: revised.bindings,
      });
      await episodic.acknowledgeIndexChange(first);
      expect(await episodic.readIndexChanges(1)).toHaveLength(1);
      await indexer.tick(true);
      expect(await episodic.readIndexChanges(1)).toHaveLength(0);
    } finally {
      await indexer.stop();
      episodic.close();
      semantic.close();
    }
  });
});
