import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";

import type {
  KnowledgeExtractionCandidate,
  KnowledgeExtractionJob,
  KnowledgeSourceSnapshot,
  MemorySubjectRef,
} from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKnowledgeMemoryModule, knowledgeSourceSelectionEligible } from "../src/index.ts";
import {
  createKnowledgeLearningStore,
  type KnowledgeLearningStore,
} from "../src/knowledge/store.ts";

const roots: string[] = [];
const now = new Date("2026-08-05T08:00:00.000Z");
const sourceDigest = "a".repeat(64);
const due = new Date(now.getTime() + 6 * 60 * 60_000);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Knowledge learning jobs", () => {
  it("upgrades v1 jobs with debounce timestamps and preserves a backup", async () => {
    const root = await temporaryRoot();
    const dataRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot(
      "pragma.memory.knowledge-learning",
    );
    await mkdir(dataRoot, { recursive: true });
    const databasePath = join(dataRoot, "knowledge.sqlite");
    const legacy = {
      schemaVersion: "pragma.memory-knowledge-job/v1",
      id: "legacy-job",
      revision: 1,
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest,
      status: "pending",
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE schema_meta(version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) VALUES (1);
      CREATE TABLE jobs(
        id TEXT PRIMARY KEY, root_key TEXT NOT NULL, source_digest TEXT NOT NULL,
        status TEXT NOT NULL, retry_at TEXT, lease_until TEXT, job_json TEXT NOT NULL,
        UNIQUE(root_key, source_digest)
      );
    `);
    database
      .prepare("INSERT INTO jobs VALUES (?, ?, ?, 'pending', NULL, NULL, ?)")
      .run(legacy.id, "pragma.expert\0expert-a", sourceDigest, JSON.stringify(legacy));
    database.close();

    const store = await createKnowledgeLearningStore({ pragmaHome: root });
    expect(await store.listJobs()).toEqual([
      expect.objectContaining({
        schemaVersion: "pragma.memory-knowledge-job/v2",
        firstFactAt: now.toISOString(),
        deadlineAt: "2026-08-06T08:00:00.000Z",
      }),
    ]);
    await expect(stat(`${databasePath}.v1.backup`)).resolves.toBeDefined();
    store.close();
  });

  it("debounces Fact changes for six quiet hours and caps the batch at twenty-four hours", async () => {
    const store = await temporaryStore();
    const first = await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: "1".repeat(64),
      now,
    });
    expect(first).toMatchObject({
      eligibleAt: "2026-08-05T14:00:00.000Z",
      deadlineAt: "2026-08-06T08:00:00.000Z",
    });

    const second = await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: "2".repeat(64),
      now: new Date("2026-08-05T13:00:00.000Z"),
    });
    expect(second).toMatchObject({
      id: first!.id,
      eligibleAt: "2026-08-05T19:00:00.000Z",
      deadlineAt: "2026-08-06T08:00:00.000Z",
    });

    const capped = await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: "3".repeat(64),
      now: new Date("2026-08-06T07:00:00.000Z"),
    });
    expect(capped).toMatchObject({
      id: first!.id,
      eligibleAt: "2026-08-06T08:00:00.000Z",
      deadlineAt: "2026-08-06T08:00:00.000Z",
    });
    expect(await store.claimDueJob(new Date("2026-08-06T07:59:59.999Z"))).toBeUndefined();
    expect(await store.claimDueJob(new Date("2026-08-06T08:00:00.000Z"))).toMatchObject({
      sourceDigest: "3".repeat(64),
      status: "running",
    });
    store.close();
  });

  it("deduplicates a source digest and records retained or rejected completion", async () => {
    const store = await temporaryStore();
    const scheduled = await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest,
      now,
    });

    expect(scheduled?.status).toBe("pending");
    expect(
      await store.schedule({
        rootRef: ref("pragma.expert", "expert-a"),
        sourceDigest,
        now: new Date(now.getTime() + 1_000),
      }),
    ).toBeUndefined();

    const claimed = await store.claimDueJob(due);
    expect(await store.isClaimCurrent(claimed!)).toBe(true);
    await store.completeLearned(claimed!, now);
    expect(await store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "retained" }),
    ]);
    expect(await store.inspect()).toMatchObject({ jobs: 1, completed: 1 });
    store.close();
  });

  it("expedites, interrupts, retries, wakes, and deletes jobs with revision checks", async () => {
    const store = await temporaryStore();
    await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest,
      now: new Date(now.getTime() - 60_000),
    });
    const [pending] = await store.listJobs();
    await store.expediteJob({ id: pending!.id, expectedRevision: pending!.revision, now });
    await expect(
      store.expediteJob({ id: pending!.id, expectedRevision: pending!.revision, now }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const claimed = await store.claimDueJob(now);
    const interrupted = await store.interruptJob({
      id: claimed!.id,
      expectedRevision: claimed!.revision,
      now,
    });
    expect(interrupted).toMatchObject({
      status: "pending",
      retryAt: "2026-08-05T14:00:00.000Z",
    });
    await store.expediteJob({ id: interrupted.id, expectedRevision: interrupted.revision, now });
    const reclaimed = await store.claimDueJob(now);
    await store.fail({
      job: reclaimed!,
      errorCode: "memory_extractor_profile_invalid",
      retry: "configuration",
      now,
    });
    const [attention] = await store.listJobs();
    expect(await store.inspect()).toMatchObject({
      needsAttention: 1,
      lastErrorCode: "memory_extractor_profile_invalid",
    });

    await store.retryJob({ id: attention!.id, expectedRevision: attention!.revision, now });
    const rerun = await store.claimDueJob(now);
    await store.fail({
      job: rerun!,
      errorCode: "memory_extractor_profile_invalid",
      retry: "configuration",
      now,
    });
    const [wakeable] = await store.listJobs();
    await store.wakeNeedsAttention(now, "configuration");
    const [woken] = await store.listJobs();
    expect(woken?.status).toBe("pending");

    await store.expediteJob({ id: woken!.id, expectedRevision: woken!.revision, now });
    const finalRun = await store.claimDueJob(now);
    await store.fail({
      job: finalRun!,
      errorCode: "memory_capacity_exceeded",
      retry: "capacity",
      now,
    });
    const [deletable] = await store.listJobs();
    expect(deletable?.revision).toBeGreaterThan(wakeable!.revision);
    await store.deleteJob({ id: deletable!.id, expectedRevision: deletable!.revision });
    expect(await store.listJobs()).toEqual([]);
    store.close();
  });

  it("reclaims expired leases and ignores completion from a stale claim", async () => {
    const store = await temporaryStore();
    const first = await claimedJob(store);
    const reclaimed = await store.claimDueJob(new Date(due.getTime() + 6 * 60_000));

    expect(reclaimed).toMatchObject({
      id: first.id,
      revision: first.revision + 1,
      status: "running",
    });
    expect(await store.isClaimCurrent(first)).toBe(false);
    await expect(store.completeRejected(first, now)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    store.close();
  });

  it("purges only completed job diagnostics after the fixed retention window", async () => {
    const store = await temporaryStore();
    const job = await claimedJob(store);
    await store.completeRejected(job, now);

    expect(await store.maintain(new Date("2026-09-03T08:00:00.000Z"))).toEqual({
      deletedJobs: 0,
    });
    expect(await store.maintain(new Date("2026-09-05T08:00:00.001Z"))).toEqual({
      deletedJobs: 1,
    });
    expect(await store.listJobs()).toEqual([]);
    store.close();
  });

  it("submits extracted content to the Host sink without creating Memory authority", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const root = await temporaryRoot();
    const module = await createKnowledgeMemoryModule({
      pragmaHome: root,
      sourceReader: {
        listEligibleSources: async () => sourceRevisions,
      },
      extractor: {
        extract: async () => ({
          output: { retain: true, candidates: [extractionCandidate()] },
          provenance: {
            curatorRef: "pragma.memory.curator",
            promptVersion: "knowledge-curator/v1",
            profileRevision: 1,
            runtimeId: "runtime-a",
            providerId: "provider-a",
            modelId: "model-a",
            extractedAt: now.toISOString(),
          },
        }),
      },
      learningSink: { submit },
      now: () => now,
    });
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(sourceRevisions),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });

    await module.runBackgroundOnce?.();

    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(sourceRevisions),
      candidates: [extractionCandidate()],
      sources: sourceRevisions,
    });
    expect(await module.store.inspect()).toMatchObject({ jobs: 1, completed: 1 });
    expect(Object.keys(module.store)).not.toContain("publishCandidate");
    expect(Object.keys(module.store)).not.toContain("listForRecall");
    module.close();
  });

  it("requires a verified Semantic source or Semantic support from two executions", () => {
    const [episode, semantic] = sources();
    expect(knowledgeSourceSelectionEligible([episode!])).toBe(false);
    expect(knowledgeSourceSelectionEligible([semantic!])).toBe(true);
    expect(
      knowledgeSourceSelectionEligible([
        { ...semantic!, verified: false, sourceExecutionIds: ["execution-a"] },
        {
          ...semantic!,
          ref: { ...semantic!.ref, id: "fact-b" },
          verified: false,
          sourceExecutionIds: ["execution-b"],
        },
      ]),
    ).toBe(true);
  });
});

async function claimedJob(store: KnowledgeLearningStore): Promise<KnowledgeExtractionJob> {
  await store.schedule({
    rootRef: ref("pragma.expert", "expert-a"),
    sourceDigest,
    now,
  });
  return (await store.claimDueJob(due))!;
}

function extractionCandidate(): KnowledgeExtractionCandidate {
  return {
    content: {
      title: "Verify migrations before changing schemas",
      summary: "Persistent schema changes must ship with an executable adjacent migration.",
      guidance: ["Add a historical fixture.", "Exercise crash recovery before merging."],
      normalizedKey: "storage.schema-migration",
    },
    sourceRefs: sources().map((source) => source.ref),
  };
}

function sources(): readonly KnowledgeSourceSnapshot[] {
  return [
    {
      ref: { kind: "episodic", id: "episode-a", revision: 2 },
      rootRef: ref("pragma.expert", "expert-a"),
      producerRefs: [ref("pragma.expert", "expert-a")],
      sourceExecutionIds: ["execution-a"],
      title: "Migration recovery",
      body: "An interrupted schema migration recovered from its journal.",
      observedAt: "2026-08-04T08:00:00.000Z",
      verified: false,
      valueScore: 0.9,
      visibility: { mode: "public" },
      sensitivity: "internal",
    },
    {
      ref: { kind: "semantic", id: "fact-a", revision: 1 },
      rootRef: ref("pragma.expert", "expert-a"),
      producerRefs: [ref("pragma.expert", "expert-a")],
      sourceExecutionIds: ["execution-b"],
      title: "Migration policy",
      body: "Every persistent schema upgrade requires an adjacent migration.",
      observedAt: "2026-08-04T09:00:00.000Z",
      verified: true,
      visibility: { mode: "public" },
      sensitivity: "internal",
    },
  ];
}

function digestSources(sourceRevisions: readonly KnowledgeSourceSnapshot[]): string {
  const keys = sourceRevisions
    .map((source) =>
      JSON.stringify({
        kind: source.ref.kind,
        id: source.ref.id,
        producerRefs: source.producerRefs,
        sourceExecutionIds: source.sourceExecutionIds,
        title: source.title,
        body: source.body,
        observedAt: source.observedAt,
        verified: source.verified,
        valueScore: source.valueScore,
        visibility: source.visibility,
        sensitivity: source.sensitivity,
      }),
    )
    .toSorted();
  return createHash("sha256")
    .update(["knowledge-sources", ...keys].join("\0"))
    .digest("hex");
}

function ref(type: string, id: string): MemorySubjectRef {
  return { type, id };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-knowledge-learning-"));
  roots.push(root);
  return root;
}

async function temporaryStore(): Promise<KnowledgeLearningStore> {
  return await createKnowledgeLearningStore({ pragmaHome: await temporaryRoot() });
}
