import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PragmaPaths, defaultRuntimeTokenCounter } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileMemoryAttentionStateStore,
  createMemoryAttentionController,
  createFederatedMemoryContextStore,
  createJevDecisionProvider,
  MemoryModuleRegistry,
  MEMORY_ATTENTION_POLICY,
  type MemoryAttentionCandidate,
  type MemoryAttentionInput,
  type MemoryRecallScope,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scope: MemoryRecallScope = {
  rootRef: { type: "pragma.expert", id: "a".repeat(16) },
  expertRef: { type: "pragma.expert", id: "a".repeat(16) },
};
const delta: MemoryAttentionInput = {
  missionId: "mission-a",
  contextId: "context-a",
  missionGoal: "Fix messages",
  latestObservation: "askUserQuestion checkpoint strict steer",
  lastAction: "read_file",
  trigger: "new_error",
  concepts: ["askUserQuestion", "checkpoint", "strict"],
};
const candidate: MemoryAttentionCandidate = {
  module: "episodic",
  memoryId: "episode-a",
  revision: 1,
  title: "Checkpoint recovery",
  summary: "Preserve strict steer lifecycle",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-attention-"));
  roots.push(root);
  const store = createFileMemoryAttentionStateStore({ pragmaHome: root });
  const provider = {
    assessRecall: vi.fn(async () => ({ recall: 0.95, episodic: 0.95, semantic: 0.1 })),
    assessCandidates: vi.fn(async () => [
      { key: "episodic:episode-a", relevance: 0.95, novelty: 0.9 },
    ]),
    assessAttention: vi.fn(async () => true),
  };
  const mutable = {
    generation: 1,
    enabled: true,
    readable: true,
    current: true,
    now: new Date("2026-09-28T00:00:00Z"),
  };
  const search = vi.fn(async () => [candidate]);
  const diagnostic = vi.fn(async () => undefined);
  const controller = createMemoryAttentionController({
    store,
    getBinding: async () =>
      mutable.enabled ? { generation: mutable.generation, provider } : undefined,
    read: async () => (mutable.readable ? candidate : undefined),
    search,
    isCurrent: async () => mutable.current,
    onDiagnostic: diagnostic,
    now: () => mutable.now,
  });
  return { root, store, controller, provider, mutable, search, diagnostic };
}
describe("Mission Memory Attention", () => {
  it.each(["longword ".repeat(10_000), "服务故障恢复🌏".repeat(2_000)])(
    "truncates the highest-ranked large Lens item within byte and token budgets",
    async (summary) => {
      const f = await fixture();
      const records = [
        { ...candidate, summary, similarity: 0.99 },
        {
          ...candidate,
          memoryId: "weaker",
          title: "Weaker candidate",
          summary: "Short weaker result",
          similarity: 0.9,
        },
      ];
      const controller = createMemoryAttentionController({
        store: f.store,
        getBinding: async () => ({ generation: 1, provider: undefined }),
        read: async (_scope, ref) => records.find((value) => value.memoryId === ref.memoryId),
        search: async () => records,
        isCurrent: async () => true,
        onDiagnostic: f.diagnostic,
      });
      try {
        controller.observe(delta, scope);
        await controller.flush();
        expect((await f.store.read(delta.missionId, delta.contextId))?.active).toHaveLength(2);
        const view = await controller.createContextView({ ...delta, scope });
        const lens = await view!.readContext({ id: "mission-attention.md" });
        expect(lens.ok).toBe(true);
        if (!lens.ok) throw new Error("Lens unavailable");
        expect(lens.value.content).toContain("episodic/items/episode-a.md");
        expect(lens.value.content).toContain(summary.slice(0, 100));
        expect(lens.value.content).toContain("[truncated; read source for full details]");
        expect(lens.value.content).not.toContain("Weaker candidate");
        expect(lens.value.content).not.toContain("\uFFFD");
        expect(Buffer.byteLength(lens.value.content)).toBeLessThanOrEqual(
          MEMORY_ATTENTION_POLICY.maxLensBytes,
        );
        expect(defaultRuntimeTokenCounter.countText(lens.value.content).tokens).toBeLessThanOrEqual(
          MEMORY_ATTENTION_POLICY.maxLensTokens,
        );
      } finally {
        await controller.stop();
        await f.controller.stop();
      }
    },
  );
  it("accepts a complete decision set in a different order", async () => {
    const f = await fixture();
    const second = { ...candidate, memoryId: "episode-b" };
    const controller = createMemoryAttentionController({
      store: f.store,
      getBinding: async () => ({ generation: 1, provider: f.provider }),
      read: async (_scope, ref) =>
        [candidate, second].find((item) => item.memoryId === ref.memoryId),
      search: async () => [candidate, second],
      isCurrent: async () => true,
      onDiagnostic: f.diagnostic,
    });
    try {
      f.provider.assessCandidates.mockResolvedValueOnce([
        { key: "episodic:episode-b", relevance: 0.9, novelty: 0.9 },
        { key: "episodic:episode-a", relevance: 0.1, novelty: 0.1 },
      ]);
      controller.observe(delta, scope);
      await controller.flush();
      const state = await f.store.read(delta.missionId, delta.contextId);
      expect(state?.active.map((entry) => entry.memoryId)).toEqual([second.memoryId]);
      expect(state?.audit.at(-1)?.result).toBe("updated");
    } finally {
      await controller.stop();
      await f.controller.stop();
    }
  });
  it("accepts an empty decision set for an empty candidate set", async () => {
    const f = await fixture();
    try {
      f.search.mockResolvedValueOnce([]);
      f.provider.assessCandidates.mockResolvedValueOnce([]);
      f.controller.observe(delta, scope);
      await f.controller.flush();
      const state = await f.store.read(delta.missionId, delta.contextId);
      expect(state?.active).toEqual([]);
      expect(state?.audit.at(-1)?.result).toBe("unchanged");
    } finally {
      await f.controller.stop();
    }
  });
  it("rejects a provider decision after its request candidate snapshot is mutated", async () => {
    const f = await fixture();
    const chooseExpansion = vi.fn(async () => undefined);
    const controller = createMemoryAttentionController({
      store: f.store,
      getBinding: async () => ({
        generation: 1,
        provider: {
          ...f.provider,
          chooseExpansion,
          assessCandidates: async (input) => {
            Object.assign(input.candidates[0]!, { summary: "Changed after request binding" });
            return [{ key: "episodic:episode-a", relevance: 0.9, novelty: 0.9 }];
          },
        },
      }),
      read: async () => candidate,
      search: f.search,
      isCurrent: async () => true,
      onDiagnostic: f.diagnostic,
    });
    try {
      controller.observe(delta, scope);
      await controller.flush();
      expect((await f.store.read(delta.missionId, delta.contextId))?.audit.at(-1)).toMatchObject({
        result: "failed",
        code: "attention_response_invalid",
      });
      expect(chooseExpansion).not.toHaveBeenCalled();
      expect(candidate.summary).toBe("Preserve strict steer lifecycle");
    } finally {
      await controller.stop();
      await f.controller.stop();
    }
  });
  it.each(["missing", "duplicate", "unknown"])(
    "treats %s candidate keys as a failed assessment and preserves validated attention",
    async (mode) => {
      const f = await fixture();
      try {
        f.controller.observe(delta, scope);
        await f.controller.flush();
        const second = { ...candidate, memoryId: "episode-b" };
        f.search.mockResolvedValueOnce([candidate, second]);
        const low = { key: "episodic:episode-a", relevance: 0.1, novelty: 0.1 };
        const high = { key: "episodic:episode-b", relevance: 0.9, novelty: 0.9 };
        f.provider.assessCandidates.mockResolvedValueOnce(
          mode === "missing"
            ? [low]
            : mode === "duplicate"
              ? [low, low]
              : [low, { ...high, key: "episodic:invented" }],
        );
        const read = async (_scope: MemoryRecallScope, ref: { memoryId: string }) =>
          [candidate, second].find((item) => item.memoryId === ref.memoryId);
        // This controller uses the same persisted state with both records readable.
        const controller = createMemoryAttentionController({
          store: f.store,
          getBinding: async () => ({ generation: 1, provider: f.provider }),
          read,
          search: f.search,
          isCurrent: async () => true,
          onDiagnostic: f.diagnostic,
          now: () => f.mutable.now,
        });
        try {
          controller.observe({ ...delta, latestObservation: "Different assessment input" }, scope);
          await controller.flush();
          const state = await f.store.read(delta.missionId, delta.contextId);
          expect(state?.active).toMatchObject([{ memoryId: candidate.memoryId, relevance: 0.95 }]);
          expect(state?.audit.at(-1)).toMatchObject({
            result: "failed",
            code: "attention_response_invalid",
          });
          expect(f.provider.assessAttention).toHaveBeenCalledTimes(1);
        } finally {
          await controller.stop();
        }
      } finally {
        await f.controller.stop();
      }
    },
  );
  it.each(["between_batches", "final_batch"])(
    "discards candidate decisions when a source revision changes during %s",
    async (mode) => {
      const f = await fixture();
      const records = Array.from({ length: 5 }, (_, i) => ({
        ...candidate,
        memoryId: `batch-${i}`,
      }));
      let revision = 1;
      let requests = 0;
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests++;
        if (requests === (mode === "between_batches" ? 1 : 2)) revision++;
        return Response.json({
          model: "jev",
          answers: Object.fromEntries(
            Object.keys(body.questions).map((key) => [
              key,
              key.startsWith("relevance_")
                ? { type: "score", score: 4, confidence: 1 }
                : { type: "noul", noul: 0.9 },
            ]),
          ),
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });
      const jev = createJevDecisionProvider({ getApiKey: async () => "test", fetch: fetcher });
      const chooseExpansion = vi.fn(async () => undefined);
      const controller = createMemoryAttentionController({
        store: f.store,
        getBinding: async () => ({
          generation: 1,
          provider: { ...f.provider, assessCandidates: jev.assessCandidates, chooseExpansion },
        }),
        read: async (_scope, ref) => {
          const found = records.find((record) => record.memoryId === ref.memoryId);
          return found === undefined ? undefined : { ...found, revision };
        },
        search: async () => records,
        isCurrent: async () => true,
        onDiagnostic: f.diagnostic,
      });
      try {
        controller.observe(delta, scope);
        await controller.flush();
        expect(fetcher).toHaveBeenCalledTimes(mode === "between_batches" ? 1 : 2);
        expect(chooseExpansion).not.toHaveBeenCalled();
        expect(f.provider.assessAttention).not.toHaveBeenCalled();
        expect(await f.store.read(delta.missionId, delta.contextId)).toBeUndefined();
      } finally {
        await controller.stop();
        await f.controller.stop();
      }
    },
  );
  it("preserves a pending failure while assessing against the latest routine task version", async () => {
    const f = await fixture();
    const controller = createMemoryAttentionController({
      store: f.store,
      getBinding: async () => ({ generation: 1, provider: f.provider }),
      read: async () => candidate,
      search: f.search,
      isCurrent: async (input) => input.taskVersion === 2,
      onDiagnostic: f.diagnostic,
    });
    try {
      controller.observe({ ...delta, taskVersion: 1 }, scope);
      controller.observe(
        {
          ...delta,
          trigger: "new_observation",
          latestObservation: "routine read completed",
          taskVersion: 2,
        },
        scope,
      );
      await controller.flush();
      expect(f.provider.assessRecall).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: "new_error",
          latestObservation: delta.latestObservation,
          taskVersion: 2,
        }),
        expect.any(AbortSignal),
        expect.any(Function),
      );
    } finally {
      await controller.stop();
      await f.controller.stop();
    }
  });
  it("assesses the latest task when its goal changes while an older failure is pending", async () => {
    const f = await fixture();
    const controller = createMemoryAttentionController({
      store: f.store,
      getBinding: async () => ({ generation: 1, provider: f.provider }),
      read: async () => candidate,
      search: f.search,
      isCurrent: async (input) => input.taskVersion === 2,
      onDiagnostic: f.diagnostic,
    });
    try {
      controller.observe({ ...delta, currentGoal: "old goal", taskVersion: 1 }, scope);
      controller.observe(
        { ...delta, trigger: "goal_changed", currentGoal: "new goal", taskVersion: 2 },
        scope,
      );
      await controller.flush();
      expect(f.provider.assessRecall).toHaveBeenCalledWith(
        expect.objectContaining({ currentGoal: "new goal", taskVersion: 2 }),
        expect.any(AbortSignal),
        expect.any(Function),
      );
    } finally {
      await controller.stop();
      await f.controller.stop();
    }
  });
  it("keeps at most three high-similarity unassessed memories without provider expansion", async () => {
    const f = await fixture();
    const records = Array.from({ length: 7 }, (_, i) => ({
      ...candidate,
      memoryId: `fallback-${i}`,
      similarity: i === 6 ? 0.79 : 0.91,
    }));
    const controller = createMemoryAttentionController({
      store: f.store,
      getBinding: async () => ({ generation: 1, provider: undefined }),
      read: async (_scope, ref) => records.find((record) => record.memoryId === ref.memoryId),
      search: async () => records,
      isCurrent: async () => true,
      onDiagnostic: f.diagnostic,
      now: () => f.mutable.now,
    });
    controller.observe(delta, scope);
    await controller.flush();
    expect((await f.store.read(delta.missionId, delta.contextId))?.active).toHaveLength(3);
    expect(
      (await f.store.read(delta.missionId, delta.contextId))?.active.every(
        (entry) => entry.decisionMode === "vector_unassessed" && !entry.pinned,
      ),
    ).toBe(true);
    const view = await controller.createContextView({ ...delta, scope });
    const lens = await view?.readContext({ id: "mission-attention.md" });
    expect(lens?.ok && lens.value.content).toContain(candidate.summary);
    await controller.stop();
    await f.controller.stop();
  });
  it("expands only closed actions from selected text and never evaluates a record twice", async () => {
    const f = await fixture();
    const second = {
      ...candidate,
      memoryId: "episode-b",
      summary: "Actual checkpoint recovery procedure",
    };
    const first = {
      ...candidate,
      relations: [{ module: second.module, memoryId: second.memoryId }],
    };
    const search = vi.fn(async (_scope: MemoryRecallScope, queries: readonly string[]) =>
      queries[0] === candidate.summary ? [first, second] : [first],
    );
    const provider = {
      ...f.provider,
      assessCandidates: vi.fn(async (input: { candidates: readonly MemoryAttentionCandidate[] }) =>
        input.candidates.map((value) => ({
          key: `${value.module}:${value.memoryId}`,
          relevance: 0.95,
          novelty: 0.9,
        })),
      ),
      chooseExpansion: vi.fn(
        async (input: { actions: readonly { id: string; kind: string }[] }) =>
          input.actions.find((value) => value.kind === "expand")?.id,
      ),
    };
    const controller = createMemoryAttentionController({
      store: f.store,
      getBinding: async () => ({ generation: 1, provider }),
      read: async (_scope, ref) => [first, second].find((value) => value.memoryId === ref.memoryId),
      search,
      isCurrent: async () => true,
      onDiagnostic: f.diagnostic,
      now: () => f.mutable.now,
    });
    controller.observe(delta, scope);
    await controller.flush();
    expect(search).toHaveBeenCalledWith(
      scope,
      [candidate.summary],
      [candidate.module],
      expect.any(AbortSignal),
    );
    expect(
      provider.assessCandidates.mock.calls.map(([input]) =>
        input.candidates.map((value) => value.memoryId),
      ),
    ).toEqual([[candidate.memoryId], [second.memoryId]]);
    expect((await f.store.read(delta.missionId, delta.contextId))?.active).toHaveLength(2);
    await controller.stop();
    await f.controller.stop();
  });
  it("recalls on a new observation, exposes a manual Lens, and hints only once", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    expect(f.search).toHaveBeenCalledWith(
      scope,
      [delta.missionGoal, delta.latestObservation, delta.concepts[0]],
      ["episodic"],
      expect.any(AbortSignal),
    );
    expect(await f.controller.getState(delta.missionId, delta.contextId)).toMatchObject({
      version: 1,
      active: [{ memoryId: candidate.memoryId }],
    });
    const input = { ...delta, scope };
    expect(await f.controller.consumeHint(input)).toContain("memory/mission-attention.md");
    expect(await f.controller.consumeHint(input)).toBeUndefined();
    const view = await f.controller.createContextView(input);
    expect(await view?.listContext({})).toMatchObject({
      ok: true,
      value: [{ metadata: { trigger: "manual" } }],
    });
    expect(await view?.readContext({ id: "mission-attention.md" })).toMatchObject({
      ok: true,
      value: { content: expect.stringContaining("episodic/items/episode-a.md") },
    });
    expect((await f.store.read(delta.missionId, delta.contextId))?.lastReadVersion).toBe(1);
    await f.controller.stop();
  });
  it("deduplicates observations and persists references without their observation text", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    expect(f.provider.assessRecall).toHaveBeenCalledOnce();
    expect(JSON.stringify(await f.store.read(delta.missionId, delta.contextId))).not.toContain(
      delta.latestObservation,
    );
    expect(
      (
        await createFileMemoryAttentionStateStore({ pragmaHome: f.root }).read(
          delta.missionId,
          delta.contextId,
        )
      )?.version,
    ).toBe(1);
    await f.controller.stop();
  });
  it("keeps guide and overview byte-identical across updates", async () => {
    const f = await fixture();
    const context = createFederatedMemoryContextStore(new MemoryModuleRegistry(), {
      resolveRecallScope: async () => scope,
      attention: {
        view: async () => await f.controller.createContextView({ ...delta, scope }),
        afterToolResult: async () => undefined,
      },
    });
    const before = await Promise.all(
      ["guide.md", "overview.md"].map((id) => context.readContext({ id })),
    );
    f.controller.observe(delta, scope);
    await f.controller.flush();
    const after = await Promise.all(
      ["guide.md", "overview.md"].map((id) => context.readContext({ id })),
    );
    expect(after).toEqual(before);
    expect(await context.readContext({ id: "mission-attention.md" })).toMatchObject({ ok: true });
    await f.controller.stop();
  });
  it("does not issue requests without a provider, and denies another Expert's view", async () => {
    const f = await fixture();
    f.mutable.enabled = false;
    f.controller.observe(delta, scope);
    await f.controller.flush();
    expect(f.provider.assessRecall).not.toHaveBeenCalled();
    expect(await f.controller.createContextView({ ...delta, scope })).toBeUndefined();
    f.mutable.enabled = true;
    f.controller.observe(delta, scope);
    await f.controller.flush();
    const view = await f.controller.createContextView({
      ...delta,
      scope: { ...scope, expertRef: { type: "pragma.expert", id: "b".repeat(16) } },
    });
    const read = await view?.readContext({ id: "mission-attention.md" });
    expect(read?.ok && read.value.content).not.toContain(candidate.title);
    await f.controller.stop();
  });
  it("filters forgotten memories at read time and drops results after owner deletion", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    f.mutable.readable = false;
    expect(await f.controller.consumeHint({ ...delta, scope })).toBeUndefined();
    const view = await f.controller.createContextView({ ...delta, scope });
    const read = await view?.readContext({ id: "mission-attention.md" });
    expect(read?.ok && read.value.content).not.toContain(candidate.title);
    f.mutable.current = false;
    f.controller.observe({ ...delta, latestObservation: "different error" }, scope);
    await f.controller.flush();
    expect(f.provider.assessRecall).toHaveBeenCalledOnce();
    await f.controller.stop();
  });
  it("preserves valid attention on provider failure and prunes decayed entries", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    f.provider.assessRecall.mockRejectedValueOnce(new Error("attention_provider_unavailable"));
    f.controller.observe({ ...delta, latestObservation: "second observation" }, scope);
    await f.controller.flush();
    expect((await f.store.read(delta.missionId, delta.contextId))?.active).toHaveLength(1);
    expect(f.diagnostic).toHaveBeenLastCalledWith("attention_provider_unavailable", 1);
    f.mutable.now = new Date("2026-09-28T02:00:00Z");
    f.provider.assessRecall.mockResolvedValueOnce({ recall: 0.1, episodic: 0.1, semantic: 0.1 });
    f.controller.observe({ ...delta, latestObservation: "unrelated later observation" }, scope);
    await f.controller.flush();
    expect((await f.store.read(delta.missionId, delta.contextId))?.active).toHaveLength(0);
    await f.controller.stop();
  });
  it("cancels an in-flight Mission assessment before it can publish state", async () => {
    const f = await fixture();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.provider.assessRecall.mockImplementationOnce(async (...args) => {
      const signal = (args as unknown as [unknown, AbortSignal])[1];
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { recall: 1, episodic: 1, semantic: 1 };
    });
    f.controller.observe(delta, scope);
    const flush = f.controller.flush();
    await entered;
    await f.controller.cancelMission(delta.missionId);
    await flush;
    expect(await f.store.read(delta.missionId, delta.contextId)).toBeUndefined();
    await f.controller.stop();
  });
  it("propagates Mission cancellation to the vector candidate request", async () => {
    const f = await fixture();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.search.mockImplementationOnce(async (...args) => {
      const signal = (args as unknown as [unknown, unknown, unknown, AbortSignal])[3];
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return [candidate];
    });
    f.controller.observe(delta, scope);
    const flush = f.controller.flush();
    await entered;
    await f.controller.cancelMission(delta.missionId);
    await flush;
    expect(f.provider.assessCandidates).not.toHaveBeenCalled();
    expect(await f.store.read(delta.missionId, delta.contextId)).toBeUndefined();
    await f.controller.stop();
  });
  it("does not publish results from an obsolete configuration generation", async () => {
    const f = await fixture();
    f.provider.assessAttention.mockImplementationOnce(async () => {
      f.mutable.generation++;
      return true;
    });
    f.controller.observe(delta, scope);
    await f.controller.flush();
    expect(await f.store.read(delta.missionId, delta.contextId)).toBeUndefined();
    await f.controller.stop();
  });
  it("evicts an active memory when the new assessment proves it irrelevant", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    f.provider.assessCandidates.mockResolvedValueOnce([
      { key: "episodic:episode-a", relevance: 0.1, novelty: 0.1 },
    ]);
    f.controller.observe({ ...delta, latestObservation: "A different problem" }, scope);
    await f.controller.flush();
    expect((await f.store.read(delta.missionId, delta.contextId))?.active).toEqual([]);
    await f.controller.stop();
  });
  it("does not send summaries after permissions are revoked during recall", async () => {
    const f = await fixture();
    f.provider.assessRecall.mockImplementationOnce(async () => {
      f.mutable.current = false;
      return { recall: 1, episodic: 1, semantic: 1 };
    });
    f.controller.observe(delta, scope);
    await f.controller.flush();
    expect(f.provider.assessCandidates).not.toHaveBeenCalled();
    expect(f.provider.assessAttention).not.toHaveBeenCalled();
    expect(await f.store.read(delta.missionId, delta.contextId)).toBeUndefined();
    await f.controller.stop();
  });
  it("rechecks previously created views after forget, permission changes and key rotation", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    const view = await f.controller.createContextView({ ...delta, scope });
    f.mutable.readable = false;
    const forgotten = await view?.readContext({ id: "mission-attention.md" });
    expect(forgotten?.ok && forgotten.value.content).not.toContain(candidate.title);
    f.mutable.readable = true;
    f.mutable.current = false;
    const denied = await view?.readContext({ id: "mission-attention.md" });
    expect(denied?.ok && denied.value.content).not.toContain(candidate.title);
    f.mutable.current = true;
    const acknowledged = (await f.store.read(delta.missionId, delta.contextId))?.lastReadVersion;
    f.mutable.generation++;
    const rotated = await view?.readContext({ id: "mission-attention.md" });
    expect(rotated?.ok && rotated.value.content).not.toContain(candidate.title);
    expect((await f.store.read(delta.missionId, delta.contextId))?.lastReadVersion).toBe(
      acknowledged,
    );
    expect(await view?.addContext({ id: "injected", content: "unauthorized" })).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    await f.controller.stop();
  });
  it("preserves a pending error when a routine completion arrives in the debounce window", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    f.controller.observe(
      { ...delta, trigger: "new_observation", latestObservation: "Routine file read" },
      scope,
    );
    await f.controller.flush();
    expect(f.provider.assessRecall).toHaveBeenCalledWith(
      delta,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    await f.controller.stop();
  });
  it.each(["read", "hint", "both"] as const)(
    "commits a decision while %s acknowledgement changes the state revision",
    async (ack) => {
      const f = await fixture();
      f.controller.observe(delta, scope);
      await f.controller.flush();
      let release!: () => void;
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      f.provider.assessCandidates.mockImplementationOnce(async () => {
        enter();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [{ key: "episodic:episode-a", relevance: 0.1, novelty: 0.1 }];
      });
      f.controller.observe(
        { ...delta, latestObservation: "This episode no longer applies" },
        scope,
      );
      const assessing = f.controller.flush();
      await entered;
      if (ack !== "read") expect(await f.controller.consumeHint({ ...delta, scope })).toBeDefined();
      if (ack !== "hint") {
        const view = await f.controller.createContextView({ ...delta, scope });
        expect(await view?.readContext({ id: "mission-attention.md" })).toMatchObject({ ok: true });
      }
      release();
      await assessing;
      const result = await f.store.read(delta.missionId, delta.contextId);
      expect(result).toMatchObject({
        version: 2,
        active: [],
        lastReadVersion: ack === "hint" ? 0 : 1,
        lastHintedVersion: ack === "read" ? 0 : 1,
      });
      expect(result!.revision).toBeGreaterThan(2);
      await f.controller.stop();
    },
  );
  it("rejects an obsolete decision after another content update", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    f.provider.assessCandidates.mockImplementationOnce(async () => {
      enter();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [{ key: "episodic:episode-a", relevance: 0.1, novelty: 0.1 }];
    });
    f.controller.observe({ ...delta, latestObservation: "Older pending assessment" }, scope);
    const assessing = f.controller.flush();
    await entered;
    await f.store.update(delta.missionId, delta.contextId, (current) => ({
      ...current!,
      revision: current!.revision + 1,
      lastDeltaDigest: "newer-content-decision",
    }));
    release();
    await assessing;
    expect(await f.store.read(delta.missionId, delta.contextId)).toMatchObject({
      lastDeltaDigest: "newer-content-decision",
      active: [{ memoryId: candidate.memoryId }],
    });
    await f.controller.stop();
  });
  it("keeps Lens content and version stable when only an internal relevance score changes", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    const view = await f.controller.createContextView({ ...delta, scope });
    const before = await view?.readContext({ id: "mission-attention.md" });
    f.provider.assessCandidates.mockResolvedValueOnce([
      { key: "episodic:episode-a", relevance: 0.8, novelty: 0.9 },
    ]);
    f.controller.observe(
      { ...delta, latestObservation: "Same precedent with a different confidence" },
      scope,
    );
    await f.controller.flush();
    const after = await view?.readContext({ id: "mission-attention.md" });
    expect(after?.ok && after.value.content).toBe(before?.ok && before.value.content);
    expect(await f.store.read(delta.missionId, delta.contextId)).toMatchObject({
      version: 1,
      active: [{ relevance: 0.8 }],
    });
    await f.controller.stop();
  });
  it("rejects future state versions without rewriting their bytes", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    const path = new PragmaPaths({ pragmaHome: f.root }).memoryAttentionState(
      delta.missionId,
      delta.contextId,
    );
    await writeFile(path, JSON.stringify({ schemaVersion: "pragma.memory-attention/v99" }));
    await expect(f.store.read(delta.missionId, delta.contextId)).rejects.toThrow();
    await f.controller.stop();
  });
});
