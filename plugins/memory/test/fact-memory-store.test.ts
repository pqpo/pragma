import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileSystemFactMemoryStore } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("file-system FactMemoryStore", () => {
  it("lists facts by scope, confidence, tags, and active state", async () => {
    const store = await createStore();

    await store.upsert({
        id: "fact-1",
        type: "fact",
        scope: "workspace",
        statement: "@pragma/core loop code lives under packages/core/src/loop.",
        confidence: "high",
        observedAt: "2026-07-06T00:00:00.000Z",
        tags: ["codebase", "loop"],
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
    });
    await store.upsert({
        id: "fact-2",
        type: "fact",
        scope: "workspace",
        statement: "Deprecated path.",
        confidence: "verified",
        observedAt: "2026-07-05T00:00:00.000Z",
        invalidatedAt: "2026-07-06T00:00:00.000Z",
        tags: ["codebase"],
        provenance: {
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-2" }],
        },
    });

    const listed = await store.list({
      scope: "workspace",
      confidenceAtLeast: "high",
      onlyActive: true,
      tags: ["codebase"],
    });

    expect(listed).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "fact-1" })],
    });
  });

  it("excludes superseded or invalidated facts from runtime retrieval", async () => {
    const store = await createStore();

    await store.upsert({
        id: "fact-1",
        type: "fact",
        scope: "workspace",
        statement: "Old loop path.",
        confidence: "verified",
        observedAt: "2026-07-05T00:00:00.000Z",
        supersededBy: { type: "fact", id: "fact-2" },
        provenance: {
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
    });
    await store.upsert({
        id: "fact-2",
        type: "fact",
        scope: "workspace",
        statement: "@pragma/core loop code lives under packages/core/src/loop.",
        confidence: "verified",
        observedAt: "2026-07-06T00:00:00.000Z",
        verifiedAt: "2026-07-06T00:00:00.000Z",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-2" }],
        },
    });

    const retrieved = await store.retrieveForRuntime({
      agentId: "agent-a",
      query: "packages/core/src/loop",
    });

    expect(retrieved).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "fact-2" })],
    });
  });

  it("keeps conflicting facts addressable", async () => {
    const store = await createStore();

    await store.upsert({
        id: "fact-1",
        type: "fact",
        scope: "workspace",
        statement: "Loop code path A",
        confidence: "high",
        observedAt: "2026-07-06T00:00:00.000Z",
        conflictsWith: [{ type: "fact", id: "fact-2" }],
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
    });
    await store.upsert({
        id: "fact-2",
        type: "fact",
        scope: "workspace",
        statement: "Loop code path B",
        confidence: "high",
        observedAt: "2026-07-06T01:00:00.000Z",
        conflictsWith: [{ type: "fact", id: "fact-1" }],
        provenance: {
          createdAt: "2026-07-06T01:00:00.000Z",
          updatedAt: "2026-07-06T01:00:00.000Z",
          evidence: [{ type: "external", id: "search-2" }],
        },
    });

    const first = await store.get({ id: "fact-1" });
    const second = await store.get({ id: "fact-2" });

    expect(first).toMatchObject({
      ok: true,
      value: { conflictsWith: [{ id: "fact-2" }] },
    });
    expect(second).toMatchObject({
      ok: true,
      value: { conflictsWith: [{ id: "fact-1" }] },
    });
  });

  it("lists and searches facts in stable priority order", async () => {
    const store = await createStore();

    await store.upsert({
        id: "fact-1",
        type: "fact",
        scope: "workspace",
        statement: "packages/core/src/loop is a candidate path.",
        confidence: "high",
        observedAt: "2026-07-06T00:00:00.000Z",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
    });
    await store.upsert({
        id: "fact-2",
        type: "fact",
        scope: "workspace",
        statement: "packages/core/src/loop is the verified path.",
        confidence: "verified",
        observedAt: "2026-07-06T01:00:00.000Z",
        verifiedAt: "2026-07-06T01:00:00.000Z",
        provenance: {
          createdAt: "2026-07-06T01:00:00.000Z",
          updatedAt: "2026-07-06T01:00:00.000Z",
          evidence: [{ type: "external", id: "search-2" }],
        },
    });

    const listed = await store.list({});
    const searched = await store.search({
      query: "packages/core/src/loop",
    });

    expect(listed).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "fact-2" }), expect.objectContaining({ id: "fact-1" })],
    });
    expect(searched).toMatchObject({
      ok: true,
      value: [
        expect.objectContaining({ record: expect.objectContaining({ id: "fact-2" }) }),
        expect.objectContaining({ record: expect.objectContaining({ id: "fact-1" }) }),
      ],
    });
  });

  it("persists fact entries to disk", async () => {
    const dir = await mkdtemp(join(process.cwd(), "tmp-fact-memory-"));
    tempDirs.push(dir);
    const filePath = join(dir, "fact.json");
    const firstStore = createFileSystemFactMemoryStore({
      agentId: "agent-a",
      filePath,
    });

    await firstStore.upsert({
        id: "fact-1",
        type: "fact",
        scope: "workspace",
        statement: "Persisted fact statement.",
        confidence: "high",
        observedAt: "2026-07-06T00:00:00.000Z",
        provenance: {
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
          evidence: [{ type: "external", id: "search-1" }],
        },
    });

    const secondStore = createFileSystemFactMemoryStore({
      agentId: "agent-a",
      filePath,
    });
    const listed = await secondStore.list({});

    expect(listed).toMatchObject({
      ok: true,
      value: [expect.objectContaining({ id: "fact-1" })],
    });
  });
});

async function createStore() {
  const dir = await mkdtemp(join(process.cwd(), "tmp-fact-memory-"));
  tempDirs.push(dir);

  return createFileSystemFactMemoryStore({
    agentId: "agent-a",
    filePath: join(dir, "fact.json"),
  });
}
