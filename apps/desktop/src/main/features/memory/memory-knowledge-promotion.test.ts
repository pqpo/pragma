import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import { createContextStoreStore } from "../context-stores/context-store-store.ts";
import {
  createMemoryKnowledgePromotionService,
  groupMemoryKnowledgeProposalsByExpert,
} from "./memory-knowledge-promotion.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Memory knowledge promotion", () => {
  it("initializes one structured Store per Expert, then submits revisions instead of writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-memory-promotion-"));
    directories.push(directory);
    const contextStores = createContextStoreStore({
      storesPath: join(directory, "data", "context-stores"),
    });
    const submit = vi.fn(async (request) => ({ request }));
    const scheduleProcessing = vi.fn();
    const revisions = { submit, scheduleProcessing } as unknown as ContextStoreRevisionService;
    const mountStore = vi.fn(async () => undefined);
    const promotion = createMemoryKnowledgePromotionService({
      statePath: join(directory, "state", "memory-knowledge-promotion"),
      contextStores,
      revisions,
      mountStore,
      expertExists: vi.fn(async () => true),
    });
    const expertRef = "expert:0000000000000001";
    const proposals = [
      {
        title: "Retry safely",
        summary: "Retry idempotent work after checking its current state.",
        guidance: ["Use a stable idempotency key."],
        normalizedKey: "retry-safely",
      },
    ];

    await promotion.routeLearning({
      expertRefs: [expertRef],
      sourceDigest: "1".repeat(64),
      proposals,
    });
    const [candidate] = await promotion.list();
    expect(candidate).toMatchObject({
      expertRef,
      state: "pending_review",
      files: expect.arrayContaining([
        expect.objectContaining({
          id: "guide.md",
          metadata: expect.objectContaining({ trigger: "always_on" }),
        }),
        expect.objectContaining({ id: "overview.md" }),
        expect.objectContaining({ id: "index.md" }),
        expect.objectContaining({
          id: expect.stringMatching(/^items\/retry-safely-[a-f0-9]{12}\.md$/u),
        }),
      ]),
    });
    const item = candidate!.files.find((file) => file.id.startsWith("items/"))!;
    const overview = candidate!.files.find((file) => file.id === "overview.md")!;
    const indexPart = candidate!.files.find((file) => file.id.startsWith("indexes/"))!;
    expect(overview.content).toContain(`](${item.id})`);
    expect(indexPart.content).toContain(`](${item.id})`);
    expect(candidate!.files.find((file) => file.id === "index.md")!.content).toContain(
      `](${indexPart.id})`,
    );

    const store = await promotion.createStore({
      id: candidate!.id,
      expectedRevision: candidate!.revision,
    });
    expect(mountStore).toHaveBeenCalledWith(expertRef, store.id);
    await expect(contextStores.history(store.id)).resolves.toEqual([
      expect.objectContaining({ revision: 1, author: "memory-initialization" }),
    ]);

    await promotion.routeLearning({
      expertRefs: [expertRef],
      sourceDigest: "2".repeat(64),
      proposals,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: store.id,
        source: "memory-learning",
        sourceDigest: "2".repeat(64),
      }),
    );
    expect(scheduleProcessing).toHaveBeenCalledTimes(1);
    expect((await contextStores.getSnapshot(store.id)).revision).toBe(1);
  });

  it("keeps a content-free digest tombstone when its Store is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-memory-tombstone-"));
    directories.push(directory);
    const contextStores = createContextStoreStore({ storesPath: join(directory, "stores") });
    const promotion = createMemoryKnowledgePromotionService({
      statePath: join(directory, "promotion"),
      contextStores,
      revisions: {
        submit: vi.fn(),
        scheduleProcessing: vi.fn(),
      } as unknown as ContextStoreRevisionService,
      mountStore: vi.fn(),
      expertExists: vi.fn(async () => true),
    });
    const input = {
      expertRefs: ["expert:0000000000000002"],
      sourceDigest: "3".repeat(64),
      proposals: [
        {
          title: "Boundary",
          summary: "Keep boundaries explicit.",
          guidance: [],
          normalizedKey: "boundary",
        },
      ],
    };
    await promotion.routeLearning(input);
    const [candidate] = await promotion.list();
    const store = await promotion.createStore({
      id: candidate!.id,
      expectedRevision: candidate!.revision,
    });
    await promotion.clearStoreBinding(store.id);

    await promotion.routeLearning(input);
    expect(await promotion.list({ state: "pending_review" })).toEqual([]);
    await promotion.routeLearning({ ...input, sourceDigest: "4".repeat(64) });
    expect(await promotion.list({ state: "pending_review" })).toHaveLength(1);
  });

  it("keeps one pending initialization candidate and merges later learning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-memory-single-candidate-"));
    directories.push(directory);
    const promotion = createMemoryKnowledgePromotionService({
      statePath: join(directory, "promotion"),
      contextStores: createContextStoreStore({ storesPath: join(directory, "stores") }),
      revisions: {
        submit: vi.fn(),
        scheduleProcessing: vi.fn(),
      } as unknown as ContextStoreRevisionService,
      mountStore: vi.fn(),
      expertExists: vi.fn(async () => true),
    });
    const expertRefs = ["expert:0000000000000003"];
    await promotion.routeLearning({
      expertRefs,
      sourceDigest: "5".repeat(64),
      proposals: [
        { title: "First", summary: "First detail", guidance: ["A"], normalizedKey: "first" },
      ],
    });
    await promotion.routeLearning({
      expertRefs,
      sourceDigest: "6".repeat(64),
      proposals: [
        { title: "Second", summary: "Second detail", guidance: ["B"], normalizedKey: "second" },
      ],
    });

    const candidates = await promotion.list();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ revision: 2, sourceDigest: "6".repeat(64) });
    expect(candidates[0]!.files.filter((file) => file.id.startsWith("items/"))).toHaveLength(2);
  });

  it("routes each proposal only to Experts that produced its source", () => {
    const first = {
      title: "First",
      summary: "First detail",
      guidance: ["A"],
      normalizedKey: "first",
    };
    const second = {
      title: "Second",
      summary: "Second detail",
      guidance: ["B"],
      normalizedKey: "second",
    };
    const grouped = groupMemoryKnowledgeProposalsByExpert({
      rootRef: { type: "pragma.expert-team", id: "team" },
      candidates: [
        { content: first, sourceRefs: [{ kind: "episodic", id: "one", revision: 1 }] },
        { content: second, sourceRefs: [{ kind: "semantic", id: "two", revision: 1 }] },
      ],
      sources: [
        {
          ref: { kind: "episodic", id: "one", revision: 1 },
          rootRef: { type: "pragma.expert-team", id: "team" },
          producerRefs: [{ type: "pragma.expert", id: "0000000000000004" }],
          title: "One",
          body: "One",
          observedAt: "2026-01-01T00:00:00.000Z",
          verified: true,
          visibility: { mode: "host-private" },
          sensitivity: "internal",
        },
        {
          ref: { kind: "semantic", id: "two", revision: 1 },
          rootRef: { type: "pragma.expert-team", id: "team" },
          producerRefs: [{ type: "pragma.expert", id: "0000000000000005" }],
          title: "Two",
          body: "Two",
          observedAt: "2026-01-01T00:00:00.000Z",
          verified: true,
          visibility: { mode: "host-private" },
          sensitivity: "internal",
        },
      ],
    });

    expect(grouped.get("expert:0000000000000004")).toEqual([first]);
    expect(grouped.get("expert:0000000000000005")).toEqual([second]);
  });
});
