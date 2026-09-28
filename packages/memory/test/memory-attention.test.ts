import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileMemoryAttentionStateStore,
  createMemoryAttentionController,
  createFederatedMemoryContextStore,
  MemoryModuleRegistry,
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
  it("recalls on a new observation, exposes a manual Lens, and hints only once", async () => {
    const f = await fixture();
    f.controller.observe(delta, scope);
    await f.controller.flush();
    expect(f.search).toHaveBeenCalledWith(scope, delta.concepts, ["episodic"]);
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
