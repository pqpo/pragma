import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryPolicyStore } from "@pragma/memory";
import { describe, expect, it, vi } from "vitest";
import { installMemoryPolicyHandlers } from "./memory-policy-ipc.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electron.handlers.set(channel, handler);
  }),
}));
vi.mock("electron", () => ({ ipcMain: { handle: electron.handle } }));

describe("Memory policy IPC", () => {
  it("fuses catalog vector hits with keywords and preserves filters and browsing order", async () => {
    const fact = (id: string, statement: string, updatedAt: string, status = "active") => ({
      id,
      statement,
      updatedAt,
      status,
      revision: 1,
      createdAt: updatedAt,
      rootRefs: [],
      producerRefs: [],
      evidenceRefs: [],
      bindings: [],
      visibility: { mode: "host-private" },
      sensitivity: "internal",
      subjectRefs: [],
      predicate: "preference",
      normalizedValue: statement,
      confidence: 1,
      conflictsWith: [],
    });
    const records = [
      fact("both", "concise", "2026-10-01T00:00:00.000Z"),
      fact("vector", "short answers", "2026-10-02T00:00:00.000Z"),
      fact("keyword", "concise text", "2026-10-03T00:00:00.000Z"),
      fact("invalid", "obsolete", "2026-10-04T00:00:00.000Z", "invalidated"),
    ];
    const hit = (memoryId: string, revision = 1, module = "semantic") => ({
      module,
      memoryId,
      revision,
    });
    const searchCatalog = vi.fn(async () => [
      hit("vector"),
      hit("both"),
      hit("invalid"),
      hit("keyword", 0),
      hit("missing"),
      hit("vector", 1, "episodic"),
    ]);
    installMemoryPolicyHandlers(
      {
        episodicStore: { list: vi.fn(async () => []) },
        semanticStore: { list: vi.fn(async () => records) },
        retrieval: { searchCatalog },
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[0],
      {
        project: { get: async () => ({ resources: [] }) },
        systemExperts: { list: () => [] },
        curator: { subscribeRunChat: vi.fn() },
        getWindow: () => null,
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[1],
    );
    const list = (input: object) =>
      electron.handlers.get("memory-items:list")!({}, input) as Promise<Array<{ id: string }>>;
    expect((await list({ module: "semantic", query: "concise" })).map((item) => item.id)).toEqual([
      "both",
      "keyword",
      "vector",
    ]);
    expect(searchCatalog).toHaveBeenCalledWith("concise", ["semantic"], 200);
    expect(
      (await list({ module: "semantic", query: "concise", limit: 1 })).map((item) => item.id),
    ).toEqual(["both"]);
    expect(
      (await list({ module: "semantic", query: "concise", offset: 1, limit: 2 })).map(
        (item) => item.id,
      ),
    ).toEqual(["keyword", "vector"]);
    expect(await list({ module: "semantic", query: "concise", offset: 3, limit: 2 })).toEqual([]);
    const page = (input: object) =>
      electron.handlers.get("memory-items:list-page")!({}, input) as Promise<{
        items: Array<{ id: string }>;
        total: number;
      }>;
    const filteredPage = await page({ module: "semantic", query: "concise", offset: 1, limit: 1 });
    expect(filteredPage.total).toBe(3);
    expect(filteredPage.items.map((item) => item.id)).toEqual(["keyword"]);
    const allPage = await page({ module: "all", status: "all", limit: 1 });
    expect(allPage.total).toBe(4);
    expect(allPage.items).toHaveLength(1);
    expect((await page({ module: "episodic" })).total).toBe(0);
    searchCatalog.mockClear();
    expect((await list({ module: "semantic" })).map((item) => item.id)).toEqual([
      "keyword",
      "vector",
      "both",
    ]);
    expect(searchCatalog).not.toHaveBeenCalled();
    searchCatalog.mockResolvedValue([]);
    expect((await list({ module: "semantic", query: "concise" })).map((item) => item.id)).toEqual([
      "keyword",
      "both",
    ]);
  });

  it("paginates the catalog past 200 records without requesting embeddings for browsing", async () => {
    const records = Array.from({ length: 235 }, (_, index) => ({
      id: `fact-${index}`,
      statement: `Fact ${index}`,
      revision: 1,
      status: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      rootRefs: [],
      producerRefs: [],
      evidenceRefs: [],
      bindings: [],
      subjectRefs: [],
      visibility: { mode: "host-private" },
      sensitivity: "internal",
      predicate: "p",
      normalizedValue: "v",
      confidence: 1,
      conflictsWith: [],
    }));
    const searchCatalog = vi.fn();
    installMemoryPolicyHandlers(
      {
        episodicStore: { list: async () => [] },
        semanticStore: { list: async () => records },
        retrieval: { searchCatalog },
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[0],
      {
        project: { get: async () => ({ resources: [] }) },
        systemExperts: { list: () => [] },
        curator: { subscribeRunChat: vi.fn() },
        getWindow: () => null,
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[1],
    );
    const list = electron.handlers.get("memory-items:list")!;
    const first = (await list({}, { limit: 200 })) as Array<{ id: string }>;
    const second = (await list({}, { limit: 200, offset: 200 })) as Array<{ id: string }>;
    expect(first).toHaveLength(200);
    expect(second).toHaveLength(35);
    expect([...first, ...second].map((item) => item.id)).toEqual(
      records.toReversed().map((item) => item.id),
    );
    expect(searchCatalog).not.toHaveBeenCalled();
    searchCatalog.mockResolvedValue([]);
    const structured = (await list({}, { query: "Predicate: p", limit: 200 })) as Array<{
      id: string;
    }>;
    expect(structured).toHaveLength(200);
  });

  it("searches episode attempts, recoveries and outcomes through the Context Store rendering", async () => {
    const timestamp = "2026-10-01T00:00:00.000Z";
    const episode = {
      id: "episode",
      revision: 1,
      status: "active",
      executionId: "execution",
      terminalMessageId: "terminal",
      language: "en",
      valueScore: 1,
      goal: { text: "A task" },
      summary: { text: "A summary" },
      attempts: [{ description: "only-in-attempt", result: "only-in-result" }],
      failuresAndRecoveries: [{ failure: "only-in-failure", recovery: "only-in-recovery" }],
      outcome: { status: "succeeded", summary: "only-in-outcome" },
      createdAt: timestamp,
      updatedAt: timestamp,
      rootRefs: [],
      producerRefs: [],
      evidenceRefs: [],
      bindings: [],
      visibility: { mode: "host-private" },
      sensitivity: "internal",
    };
    installMemoryPolicyHandlers(
      {
        episodicStore: { list: async () => [episode] },
        semanticStore: { list: async () => [] },
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[0],
      {
        project: { get: async () => ({ resources: [] }) },
        systemExperts: { list: () => [] },
        curator: { subscribeRunChat: vi.fn() },
        getWindow: () => null,
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[1],
    );
    const list = electron.handlers.get("memory-items:list")!;
    for (const query of [
      "only-in-attempt",
      "only-in-result",
      "only-in-failure",
      "only-in-recovery",
      "only-in-outcome",
    ]) {
      expect(await list({}, { query })).toMatchObject([{ module: "episodic", id: "episode" }]);
    }
    // Administrative keyword browsing still includes explicitly requested historical records.
    episode.status = "invalidated";
    expect(await list({}, { query: "only-in-recovery", status: "all" })).toHaveLength(1);
  });

  it("keeps authorized recall results available when execution search text cannot be loaded", async () => {
    electron.handlers.clear();
    const readEvents = vi.fn(async () => {
      throw new Error("execution unavailable");
    });
    const listRecall = vi.fn(async () => [
      {
        schemaVersion: "pragma.memory-recall-activity/v1",
        id: "recall",
        executionId: "own",
        invocationId: "invocation",
        operation: "search",
        target: "memory",
        queryDigest: "digest",
        resultRefs: [{ id: "overview.md" }],
        outcome: "allowed",
        reason: "matched",
        occurredAt: "2026-10-10T09:00:00.000Z",
      },
    ]);
    installMemoryPolicyHandlers(
      { activity: { listRecall }, executionStore: { readEvents } } as unknown as Parameters<
        typeof installMemoryPolicyHandlers
      >[0],
      {
        missions: {
          get: vi.fn(async () => ({})),
          readTimelinePage: vi.fn(async () => ({
            turns: [
              {
                sequence: 1,
                executionId: "own",
                message: { content: "Task", createdAt: "2026-10-10T09:00:00.000Z" },
              },
            ],
          })),
        },
        memoryBrowser: { getMemorySourceReader: vi.fn(async () => async () => undefined) },
        curator: { subscribeRunChat: vi.fn() },
        getWindow: () => null,
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[1],
    );
    const page = await electron.handlers.get("memory-mission:recall")!(
      {},
      {
        missionId: "00000000-0000-4000-8000-000000000001",
        executionId: "own",
        limit: 30,
      },
    );
    expect(readEvents).toHaveBeenCalledWith("own");
    expect(page).toMatchObject({
      records: [{ operation: "search", sources: [{ id: "overview.md", available: true }] }],
    });
    expect((page as { records: object[] }).records[0]).not.toHaveProperty("query");
  });

  it("rejects recall content requests for another Mission's execution before reading sources", async () => {
    electron.handlers.clear();
    const listRecall = vi.fn();
    const getMemorySourceReader = vi.fn();
    installMemoryPolicyHandlers(
      { activity: { listRecall } } as unknown as Parameters<typeof installMemoryPolicyHandlers>[0],
      {
        missions: {
          get: vi.fn(async () => ({})),
          readTimelinePage: vi.fn(async () => ({
            turns: [
              {
                sequence: 1,
                executionId: "own",
                message: { content: "Task", createdAt: "2026-10-10T09:00:00.000Z" },
              },
            ],
          })),
        },
        memoryBrowser: { getMemorySourceReader },
        curator: { subscribeRunChat: vi.fn() },
        getWindow: () => null,
      } as unknown as Parameters<typeof installMemoryPolicyHandlers>[1],
    );
    await expect(
      electron.handlers.get("memory-mission:recall")!(
        {},
        { missionId: "00000000-0000-4000-8000-000000000001", executionId: "other", limit: 30 },
      ),
    ).rejects.toThrow("memory_execution_not_in_mission");
    expect(listRecall).not.toHaveBeenCalled();
    expect(getMemorySourceReader).not.toHaveBeenCalled();
    electron.handlers.clear();
  });

  it("cancels retrieval before and after committing an asset recall change", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-memory-policy-ipc-"));
    electron.handlers.clear();
    const policies = createFileMemoryPolicyStore({ pragmaHome });
    const cancel = vi.fn();
    const update = vi.spyOn(policies, "updateOverride");
    try {
      await policies.updateGlobal({
        expectedRevision: 0,
        policy: { enabled: "enabled", capture: "enabled", recall: "enabled", learning: "disabled" },
      });
      installMemoryPolicyHandlers(
        { policies, retrieval: { cancel } } as unknown as Parameters<
          typeof installMemoryPolicyHandlers
        >[0],
        { curator: { subscribeRunChat: vi.fn() }, getWindow: () => null } as unknown as Parameters<
          typeof installMemoryPolicyHandlers
        >[1],
      );
      const result = await electron.handlers.get("memory-policy:asset:update")!(
        {},
        {
          targetRef: { type: "pragma.expert", id: "7k2m9q4v8np6r3dt" },
          expectedRevision: 0,
          policy: { capture: "inherit", recall: "disabled", learning: "inherit" },
        },
      );
      expect(result).toMatchObject({ revision: 1, effective: { recall: false } });
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
      expect(cancel.mock.invocationCallOrder[1]).toBeGreaterThan(
        update.mock.invocationCallOrder[0]!,
      );
    } finally {
      update.mockRestore();
      electron.handlers.clear();
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });
});
