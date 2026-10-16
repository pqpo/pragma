import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SemanticFactSchema } from "@pragma/shared";
import { PragmaPaths, defaultRuntimeTokenCounter } from "@pragma/core";
import {
  createExtractionMemoryReader,
  extractionMemoryHandle,
  extractionMemoryRef,
  type ExtractionVectorSearch,
} from "../src/retrieval/extraction-memory.ts";
import { createMemoryExtractionSessionStore } from "../src/pipeline/extraction-session/store.ts";
import { EpisodicMemoryRecordSchema } from "../src/episodic/schema.ts";
import { createSemanticMemoryStore } from "../src/semantic/store.ts";
import { createEpisodicMemoryStore } from "../src/episodic/store.ts";
import type { MemoryRecallScope } from "../src/pipeline/memory-module.ts";
import { extractionInput, factArguments, provenance } from "./support/extraction.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = (name: string) => new URL(`./fixtures/retrieval/${name}`, import.meta.url);
const fact = SemanticFactSchema.parse(
  JSON.parse(readFileSync(fixture("semantic-record.json"), "utf8")),
);
const episode = EpisodicMemoryRecordSchema.parse(
  JSON.parse(readFileSync(fixture("episodic-record.json"), "utf8")),
);
const scope: MemoryRecallScope = { rootRef: { type: "pragma.expert", id: "expert-a" } };
const subjects = [{ type: "pragma.user", id: "local-user" }];
const timestamp = () => new Date("2026-10-16T00:00:00.000Z");
function catalog(vectorSearch?: ExtractionVectorSearch) {
  const state = {
    facts: [structuredClone(fact)],
    episodes: [structuredClone(episode)],
    recall: true,
  };
  const visible = (
    refs: readonly { consumerRef: { type: string; id: string }; recall: string }[],
    requested: MemoryRecallScope,
  ) =>
    refs.some(
      (binding) =>
        binding.recall === "allow" &&
        binding.consumerRef.type === requested.rootRef.type &&
        binding.consumerRef.id === requested.rootRef.id,
    );
  const reader = createExtractionMemoryReader({
    semantic: {
      listCandidatesForRecall: async (requested) =>
        state.facts.filter((item) => visible(item.bindings, requested)),
      peekForRecall: async (requested, id) =>
        state.facts.find((item) => item.id === id && visible(item.bindings, requested)),
    },
    episodic: {
      listCandidatesForRecall: async (requested) =>
        state.episodes.filter((item) => visible(item.bindings, requested)),
      peekForRecall: async (requested, id) =>
        state.episodes.find((item) => item.id === id && visible(item.bindings, requested)),
    },
    assertAccess: async () => {
      if (!state.recall) throw new Error("memory_curator_recall_denied");
    },
    vectorSearch,
    now: timestamp,
  });
  return { state, reader, access: reader.bind(scope, subjects) };
}
async function session(memory: ReturnType<typeof catalog>["access"], jobId = "job") {
  const root = await mkdtemp(join(tmpdir(), "pragma-extraction-lookup-"));
  roots.push(root);
  const store = createMemoryExtractionSessionStore({ pragmaHome: root });
  const input = extractionInput(undefined, jobId);
  const value = await store.create({ module: "semantic", input, watermark: "w", memory });
  await value.setProvenance(provenance);
  return { root, store, value, input };
}
it("combines natural-language vector matches with keyword matches and labels the actual mode", async () => {
  const vector = vi.fn<ExtractionVectorSearch>(async () => ({
    state: "ready",
    hits: [
      { module: "semantic", memoryId: fact.id, revision: 1 },
      { module: "episodic", memoryId: episode.id, revision: 1 },
    ],
  }));
  const { access } = catalog(vector);
  const lexical = await access.search({ query: "Chinese", mode: "hybrid", type: "all", limit: 10 });
  expect(lexical.items).toHaveLength(2);
  expect(lexical.items[0]?.matchedBy).toEqual(["keyword", "vector"]);
  const semantic = await access.search({
    query: "语言偏好",
    mode: "vector",
    type: "semantic",
    limit: 10,
  });
  expect(semantic.items).toHaveLength(1);
  expect(semantic.items[0]?.memory.module).toBe("semantic");
  expect(semantic.items[0]?.matchedBy).toEqual(["vector"]);
  vector.mockClear();
  const keywords = await access.search({
    query: "完成记忆架构",
    mode: "keyword",
    type: "episodic",
    limit: 10,
  });
  expect(keywords.items).toHaveLength(1);
  expect(vector).not.toHaveBeenCalled();
});
it("falls back explicitly for hybrid search but rejects unavailable vector-only search", async () => {
  const vector = vi.fn<ExtractionVectorSearch>(async () => {
    throw new Error("embedding_timeout");
  });
  const { access } = catalog(vector);
  expect(
    await access.search({ query: "Chinese", mode: "hybrid", type: "semantic", limit: 10 }),
  ).toMatchObject({
    mode: "keyword",
    reason: "embedding_timeout",
    items: [{ matchedBy: ["keyword"] }],
  });
  await expect(
    access.search({ query: "Chinese", mode: "vector", type: "semantic", limit: 10 }),
  ).rejects.toThrow("embedding_timeout");
  await expect(
    catalog().access.search({ query: "Chinese", mode: "vector", type: "all", limit: 10 }),
  ).rejects.toThrow("embedding_disabled");
});
it("revalidates scope, subjects, expiry, deletion and revisions after vector retrieval", async () => {
  const { access, state, reader } = catalog(async () => {
    state.facts[0]!.revision = 2;
    return { state: "ready", hits: [{ module: "semantic", memoryId: fact.id, revision: 1 }] };
  });
  state.facts.push({
    ...fact,
    id: "foreign",
    subjectRefs: [{ type: "pragma.user", id: "another-user" }],
  });
  state.facts.push({ ...fact, id: "expired", expiresAt: "2026-08-04T00:00:00.000Z" });
  expect((await access.list("semantic")).map((item) => item.record.id)).toEqual([fact.id]);
  await expect(reader.bind(scope, subjects, false).list("all")).rejects.toThrow("recall_denied");
  expect(
    (await access.search({ query: "语言偏好", mode: "vector", type: "semantic", limit: 10 })).items,
  ).toEqual([]);
  expect(await access.get(extractionMemoryRef("semantic", fact.id, 1))).toBeUndefined();
  expect(
    await reader
      .bind({ rootRef: { type: "pragma.expert", id: "other" } }, subjects)
      .get(extractionMemoryRef("semantic", fact.id, 2)),
  ).toBeUndefined();
  state.facts = [];
  expect(await access.get(extractionMemoryRef("semantic", fact.id, 2))).toBeUndefined();
  state.recall = false;
  await expect(access.list("all")).rejects.toThrow("recall_denied");
});
it("does not leak results when recall is revoked while embedding is in flight", async () => {
  const { access, state } = catalog(async () => {
    state.recall = false;
    return { state: "ready", hits: [{ module: "semantic", memoryId: fact.id, revision: 1 }] };
  });
  await expect(
    access.search({ query: "Chinese", mode: "hybrid", type: "all", limit: 10 }),
  ).rejects.toThrow("recall_denied");
});
it("excludes restricted memories from enumeration, vector hits and direct handle reads", async () => {
  const { access, state } = catalog(async () => ({
    state: "ready",
    hits: [
      { module: "semantic", memoryId: fact.id, revision: fact.revision },
      { module: "episodic", memoryId: episode.id, revision: episode.revision },
    ],
  }));
  const { value, store, input } = await session(access);
  const { id, revision, statement, subjectRefs, predicate, normalizedValue, observedAt } = fact;
  const legacy = await store.create({
    module: "semantic",
    input: {
      ...input,
      jobId: "legacy-restricted",
      currentFacts: [
        {
          id,
          revision,
          statement,
          subjectRefs,
          predicate,
          normalizedValue,
          conflictMode: "exclusive",
          observedAt,
        },
      ],
    },
    watermark: "w",
    memory: access,
  });
  expect(await legacy.call("find_existing_memory", {})).toContain("[f1]");
  const historical = await store.create({
    module: "episodic",
    input: {
      schemaVersion: "pragma.memory-episodic-extraction-input/v2",
      jobId: "legacy-episode-restricted",
      executionId: input.executionId,
      previousEpisode: episode,
      evidence: input.evidence,
      omittedEvidence: input.omittedEvidence,
    },
    watermark: "w",
    memory: access,
  });
  state.facts[0]!.sensitivity = "restricted";
  state.episodes[0]!.sensitivity = "restricted";
  expect(await legacy.call("find_existing_memory", {})).not.toContain("[f1]");
  await expect(legacy.call("find_existing_memory", { fact: "f1" })).rejects.toThrow(
    "fact_stale_or_denied",
  );
  await expect(legacy.call("submit_fact", { ...factArguments, property: "p1" })).rejects.toThrow(
    "fact_stale_or_denied",
  );
  await expect(historical.call("find_existing_memory", {})).rejects.toThrow(
    "memory_stale_or_denied",
  );
  expect(await access.list("all")).toEqual([]);
  expect(
    (await access.search({ query: "Chinese", type: "all", mode: "vector", limit: 10 })).items,
  ).toEqual([]);
  for (const record of [
    { module: "semantic" as const, record: state.facts[0]! },
    { module: "episodic" as const, record: state.episodes[0]! },
  ]) {
    const memory = extractionMemoryHandle(record);
    expect(await access.get(memory)).toBeUndefined();
    await expect(value.call("find_existing_memory", { memory })).rejects.toThrow(
      "memory_stale_or_denied",
    );
  }
  for (const directory of ["properties", "facts", "episodes"])
    expect(await value.call("list_existing_memory", { directory })).toContain(
      "No accessible entries.",
    );
});
it("keeps legacy fact aliases readable while enforcing live recall policy on them", async () => {
  const { access, state } = catalog();
  const { store } = await session(access);
  const input = extractionInput(undefined, "legacy");
  input.currentFacts = [
    {
      id: fact.id,
      revision: fact.revision,
      statement: fact.statement,
      subjectRefs: fact.subjectRefs,
      predicate: fact.predicate,
      normalizedValue: fact.normalizedValue,
      conflictMode: "exclusive",
      observedAt: fact.observedAt,
    },
  ];
  const legacy = await store.create({ module: "semantic", input, watermark: "w", memory: access });
  expect(await legacy.call("find_existing_memory", {})).toContain("[f1]");
  expect(await legacy.call("find_existing_memory", { fact: "f1" })).toContain(fact.statement);
  state.recall = false;
  await expect(legacy.call("find_existing_memory", { fact: "f1" })).rejects.toThrow(
    "recall_denied",
  );
  await expect(legacy.call("submit_fact", { ...factArguments, property: "p1" })).rejects.toThrow(
    "recall_denied",
  );
  await expect(legacy.call("submit_fact", factArguments)).resolves.toContain(
    "validated and staged",
  );
});
it("paginates more than 100 properties and facts without filling the legacy handle cache", async () => {
  const { access, state } = catalog();
  state.facts = Array.from({ length: 125 }, (_, index) => ({
    ...fact,
    id: `fact-${index.toString().padStart(3, "0")}`,
    predicate: `user.preference.item${index}`,
    statement: `Preference ${index}`,
    normalizedValue: String(index),
  }));
  const { value, root } = await session(access);
  for (const directory of ["properties", "facts"] as const) {
    let pageCursor: string | undefined;
    const entries: string[] = [];
    do {
      const page = await value.call("list_existing_memory", {
        directory,
        subject: "user",
        limit: 20,
        ...(pageCursor === undefined ? {} : { pageCursor }),
      });
      expect(defaultRuntimeTokenCounter.countText(page).tokens).toBeLessThanOrEqual(2000);
      entries.push(
        ...(directory === "facts"
          ? [...page.matchAll(/memory:[A-Za-z0-9_-]+/gu)].map((match) => match[0])
          : [...page.matchAll(/^Property ([^;]+)/gmu)].map((match) => match[1]!)),
      );
      const cursor = /Next pageCursor: (\S+)/u.exec(page)![1]!;
      pageCursor = cursor === "end" ? undefined : cursor;
    } while (pageCursor !== undefined);
    expect(entries).toHaveLength(125);
    expect(new Set(entries).size).toBe(125);
  }
  const db = new DatabaseSync(new PragmaPaths({ pragmaHome: root }).memoryExtractionSessions(), {
    readOnly: true,
  });
  try {
    expect(
      JSON.parse(
        (db.prepare("SELECT state_json FROM sessions").get() as { state_json: string }).state_json,
      ).facts,
    ).toHaveLength(0);
  } finally {
    db.close();
  }
});
it("invalidates listing cursors on data, scope or filter changes instead of skipping entries", async () => {
  const { access, state } = catalog();
  state.facts.push({ ...fact, id: "second" });
  const { value } = await session(access);
  const page = await value.call("list_existing_memory", { directory: "facts", limit: 1 });
  const pageCursor = /Next pageCursor: (\S+)/u.exec(page)![1];
  await expect(
    value.call("list_existing_memory", { directory: "facts", subject: "user", pageCursor }),
  ).rejects.toThrow("cursor_stale");
  state.facts[0]!.revision++;
  await expect(
    value.call("list_existing_memory", { directory: "facts", pageCursor }),
  ).rejects.toThrow("cursor_stale");
  const fresh = await value.call("list_existing_memory", {
    directory: "facts",
    property: fact.predicate,
  });
  expect([...fresh.matchAll(/memory:[A-Za-z0-9_-]+/gu)]).toHaveLength(2);
});
it.each(["properties", "facts", "episodes"])(
  "revalidates %s pages before returning excerpts and aggregates",
  async (directory) => {
    const { access, state } = catalog();
    const { value } = await session({
      ...access,
      async list(type) {
        const snapshot = structuredClone(await access.list(type));
        state.facts = [];
        state.episodes = [];
        return snapshot;
      },
    });
    await expect(value.call("list_existing_memory", { directory })).rejects.toThrow("cursor_stale");
  },
);
it("revalidates every fact contributing to a property aggregate", async () => {
  const { access, state } = catalog();
  state.facts.push({ ...fact, id: "second", normalizedValue: "en" });
  const { value } = await session({
    ...access,
    async list(type) {
      const snapshot = structuredClone(await access.list(type));
      state.facts.pop();
      return snapshot;
    },
  });
  await expect(value.call("list_existing_memory", { directory: "properties" })).rejects.toThrow(
    "cursor_stale",
  );
});
it("reads durable stateless handles and corrects replacements when the authority revision changes", async () => {
  const { access, state } = catalog();
  const { value, store, input } = await session(access);
  const handle = extractionMemoryRef("semantic", fact.id, 1);
  expect(await value.call("find_existing_memory", { memory: handle })).toContain(fact.statement);
  const staged = await value.call("submit_fact", {
    ...factArguments,
    property: handle,
    replaces: handle,
    value: "en",
  });
  const candidate = /Candidate (c\w+)/u.exec(staged)![1];
  state.facts[0]!.revision++;
  await expect(value.call("finish_extraction", { retain: true })).rejects.toThrow(
    "fact_stale_or_denied",
  );
  const resumed = await store.create({ module: "semantic", input, watermark: "w", memory: access });
  const current = extractionMemoryRef("semantic", fact.id, 2);
  await resumed.call("submit_fact", {
    ...factArguments,
    candidate,
    property: current,
    replaces: current,
    value: "en",
  });
  await resumed.call("finish_extraction", { retain: true });
  expect((await resumed.receipt())?.output).toMatchObject({
    retain: true,
    facts: [{ replacementTarget: { factId: fact.id, expectedRevision: 2 } }],
  });
});
it("pages complete memory text without allowing historical memory handles to become source evidence", async () => {
  const { access, state } = catalog();
  state.facts[0]!.statement = "保留完整正文。".repeat(500);
  const { value } = await session(access);
  const memory = extractionMemoryRef("semantic", fact.id, 1);
  let cursor = 0,
    pages = 0;
  for (;;) {
    const page = await value.call("find_existing_memory", { memory, cursor });
    expect(defaultRuntimeTokenCounter.countText(page).tokens).toBeLessThanOrEqual(2000);
    const next = /Next cursor: (\S+)/u.exec(page)![1]!;
    pages++;
    if (next === "end") break;
    expect(Number(next)).toBeGreaterThan(cursor);
    cursor = Number(next);
  }
  expect(pages).toBeGreaterThan(1);
  await expect(value.call("submit_fact", { ...factArguments, evidence: [memory] })).rejects.toThrow(
    "evidence_not_read",
  );
  const historical = extractionMemoryRef("episodic", episode.id, episode.revision);
  expect(await value.call("find_existing_memory", { memory: historical })).toContain(
    "Historical background, not new evidence",
  );
  await expect(
    value.call("submit_fact", { ...factArguments, property: historical, replaces: historical }),
  ).rejects.toThrow("fact_stale_or_denied");
  await expect(
    value.call("list_existing_memory", { directory: "episodes", property: fact.predicate }),
  ).rejects.toThrow("property filters");
});
it("does not hold the shared Session lock during an embedding request", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { access } = catalog(async () => {
    enter();
    await released;
    return { state: "ready", hits: [] };
  });
  const { value, store } = await session(access);
  const other = await store.create({
    module: "semantic",
    input: extractionInput(undefined, "other"),
    watermark: "w",
  });
  const pending = value.call("find_existing_memory", { query: "Chinese" });
  await entered;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      other.call("submit_fact", factArguments),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("lookup blocked another extraction")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    release();
  }
  expect(await pending).toContain("Search mode: hybrid");
});
it("enumerates authoritative store records without hot-memory filtering and respects real authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-extraction-authority-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  for (const [module, name] of [
    ["semantic", "facts.sqlite"],
    ["episodic", "episodes.sqlite"],
  ] as const) {
    const directory = paths.memoryModuleDataRoot(`pragma.memory.${module}`);
    await mkdir(directory, { recursive: true });
    await copyFile(fixture(`${module}-data.sqlite`), join(directory, name));
  }
  const semantic = await createSemanticMemoryStore({ pragmaHome: root }),
    episodic = await createEpisodicMemoryStore({ pragmaHome: root });
  try {
    const reader = createExtractionMemoryReader({
      semantic,
      episodic,
      assertAccess: async () => {},
      now: timestamp,
    });
    const bound = reader.bind(scope, subjects);
    const records = await bound.list("all");
    expect(records.some((item) => item.module === "semantic")).toBe(true);
    expect(records.some((item) => item.module === "episodic")).toBe(true);
    for (const record of records)
      expect(await bound.get(extractionMemoryHandle(record))).toEqual(record);
    const sessions = createMemoryExtractionSessionStore({ pragmaHome: root });
    // The production findFacts callback returns complete authority records, not
    // the already reduced currentFacts supplied in the extraction input.
    for (const query of ["", "Chinese"]) {
      const lookup = await sessions.create({
        module: "semantic",
        input: extractionInput(undefined, `authority-lookup-${query}`),
        watermark: "w",
        ...(query === "" ? { memory: bound } : {}),
        findFacts: async (text) =>
          await semantic.searchCandidatesForRecall(scope, text, 10, timestamp()),
      });
      await lookup.setProvenance(provenance);
      expect(await lookup.call("find_existing_memory", { query, cursor: 0 })).toContain("[f1]");
      expect(await lookup.call("find_existing_memory", { fact: "f1" })).toContain(fact.statement);
      await lookup.call("submit_fact", { ...factArguments, property: "p1" });
      await lookup.call("finish_extraction", { retain: true });
      expect(await sessions.recover("semantic", `authority-lookup-${query}`, "w")).toMatchObject({
        output: { retain: true, facts: [{ predicate: fact.predicate }] },
      });
    }
    expect(
      await reader.bind({ rootRef: { type: "pragma.expert", id: "other" } }, subjects).list("all"),
    ).toEqual([]);
  } finally {
    semantic.close();
    episodic.close();
  }
});
