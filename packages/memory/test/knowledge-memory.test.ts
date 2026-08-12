import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

const failureDiagnostic = (code: string) =>
  ({
    schemaVersion: "pragma.memory-extraction-failure/v1",
    code,
    message: code,
    phase: "storage",
    failedAt: "2026-08-01T00:00:00.000Z",
  }) as const;

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
        schemaVersion: "pragma.memory-knowledge-job/v3",
        firstFactAt: now.toISOString(),
        deadlineAt: "2026-08-06T08:00:00.000Z",
      }),
    ]);
    await expect(stat(`${databasePath}.v1.backup`)).resolves.toBeDefined();
    store.close();
    const migrated = new DatabaseSync(databasePath);
    expect(
      (migrated.prepare("SELECT version FROM schema_meta").get() as { version: number }).version,
    ).toBe(4);
    migrated.close();
  });

  it("requeues historical candidate validation failures in the v2 to v3 migration", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeKnowledgeV2Store(root);

    const store = await createKnowledgeLearningStore({ pragmaHome: root });
    const jobs = await store.listJobs();
    for (const id of ["source-ref-job", "threshold-job", "duplicate-job"]) {
      expect(jobs.find((job) => job.id === id)).toMatchObject({
        status: "pending",
        attempts: 0,
      });
      expect(jobs.find((job) => job.id === id)).not.toHaveProperty("lastErrorCode");
      expect(jobs.find((job) => job.id === id)).not.toHaveProperty("failureClass");
    }
    expect(jobs.find((job) => job.id === "configuration-job")).toMatchObject({
      status: "needs_attention",
      lastErrorCode: "memory_extractor_profile_invalid",
      failureClass: "configuration",
    });
    store.close();

    await expect(stat(`${databasePath}.v2.backup`)).resolves.toBeDefined();
  });

  it("opens current v3 storage without rewriting jobs", async () => {
    const root = await temporaryRoot();
    const store = await createKnowledgeLearningStore({ pragmaHome: root });
    const scheduled = await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest,
      now,
    });
    store.close();

    const reopened = await createKnowledgeLearningStore({ pragmaHome: root });
    expect(await reopened.listJobs()).toEqual([scheduled]);
    reopened.close();
  });

  it("rolls back and replays the v2 to v3 migration", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeKnowledgeV2Store(root);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER abort_candidate_migration
      BEFORE UPDATE OF status ON jobs
      WHEN NEW.id = 'source-ref-job'
      BEGIN
        SELECT RAISE(ABORT, 'simulated knowledge migration interruption');
      END;
    `);
    database.close();

    await expect(createKnowledgeLearningStore({ pragmaHome: root })).rejects.toThrow(
      "simulated knowledge migration interruption",
    );
    const interrupted = new DatabaseSync(databasePath);
    expect(
      (interrupted.prepare("SELECT version FROM schema_meta").get() as { version: number }).version,
    ).toBe(2);
    interrupted.exec("DROP TRIGGER abort_candidate_migration;");
    interrupted.close();

    const recovered = await createKnowledgeLearningStore({ pragmaHome: root });
    expect((await recovered.listJobs()).find((job) => job.id === "source-ref-job")).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    recovered.close();
  });

  it("rejects a future knowledge learning storage version", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeKnowledgeV2Store(root);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE schema_meta SET version=5").run();
    database.close();

    await expect(createKnowledgeLearningStore({ pragmaHome: root })).rejects.toThrow(
      "Unsupported pragma.memory-knowledge-learning-store version.",
    );
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
      diagnostic: failureDiagnostic("memory_extractor_profile_invalid"),
      retry: "configuration",
      now,
    });
    const [attention] = await store.listJobs();
    expect(attention).toMatchObject({
      lastErrorMessage: "memory_extractor_profile_invalid",
      lastFailure: { code: "memory_extractor_profile_invalid", phase: "storage" },
    });
    expect(await store.listFailureAttempts(attention!.id)).toEqual([
      expect.objectContaining({
        jobId: attention!.id,
        diagnostic: expect.objectContaining({ code: "memory_extractor_profile_invalid" }),
      }),
    ]);
    expect(await store.inspect()).toMatchObject({
      needsAttention: 1,
      lastErrorCode: "memory_extractor_profile_invalid",
    });

    await store.retryJob({ id: attention!.id, expectedRevision: attention!.revision, now });
    const rerun = await store.claimDueJob(now);
    await store.fail({
      job: rerun!,
      diagnostic: failureDiagnostic("memory_extractor_profile_invalid"),
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
      diagnostic: failureDiagnostic("memory_capacity_exceeded"),
      retry: "capacity",
      now,
    });
    const [deletable] = await store.listJobs();
    expect(deletable?.revision).toBeGreaterThan(wakeable!.revision);
    await store.deleteJob({ id: deletable!.id, expectedRevision: deletable!.revision });
    expect(await store.listJobs()).toEqual([]);
    expect(await store.listFailureAttempts(deletable!.id)).toEqual([]);
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

  it("filters invalid, below-threshold, and duplicate candidates while retaining valid siblings", async () => {
    const sourceRevisions = sources();
    const valid = extractionCandidate();
    const invalidRef = {
      ...extractionCandidate(),
      content: { ...valid.content, normalizedKey: "invalid.reference" },
      sourceRefs: [{ kind: "semantic" as const, id: "missing", revision: 1 }],
    };
    const belowThreshold = {
      ...extractionCandidate(),
      content: { ...valid.content, normalizedKey: "insufficient.sources" },
      sourceRefs: [sourceRevisions[0]!.ref],
    };
    const duplicate = {
      ...extractionCandidate(),
      content: { ...valid.content, title: "Duplicate should be ignored" },
    };
    const submit = vi.fn(async () => undefined);
    const module = await createExtractionModule(
      [invalidRef, belowThreshold, valid, duplicate],
      submit,
    );

    await module.runBackgroundOnce?.();

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ candidates: [valid] }));
    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "retained" }),
    ]);
    module.close();
  });

  it("completes as rejected when every extracted candidate is ineligible", async () => {
    const invalid = {
      ...extractionCandidate(),
      sourceRefs: [{ kind: "semantic" as const, id: "missing", revision: 1 }],
    };
    const submit = vi.fn(async () => undefined);
    const module = await createExtractionModule([invalid], submit);

    await module.runBackgroundOnce?.();

    expect(submit).not.toHaveBeenCalled();
    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "rejected" }),
    ]);
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

async function createExtractionModule(
  candidates: readonly KnowledgeExtractionCandidate[],
  submit: Parameters<typeof createKnowledgeMemoryModule>[0]["learningSink"]["submit"],
) {
  const sourceRevisions = sources();
  const module = await createKnowledgeMemoryModule({
    pragmaHome: await temporaryRoot(),
    sourceReader: { listEligibleSources: async () => sourceRevisions },
    extractor: {
      extract: async () => ({
        output: { retain: true as const, candidates: [...candidates] },
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
  return module;
}

async function writeKnowledgeV2Store(root: string): Promise<string> {
  const dataRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot(
    "pragma.memory.knowledge-learning",
  );
  await mkdir(dataRoot, { recursive: true });
  const databasePath = join(dataRoot, "knowledge.sqlite");
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/knowledge-learning-store-v2.json", import.meta.url), "utf8"),
  ) as { readonly jobs: readonly KnowledgeExtractionJob[] };
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) VALUES (2);
    CREATE TABLE jobs(
      id TEXT PRIMARY KEY, root_key TEXT NOT NULL, source_digest TEXT NOT NULL,
      status TEXT NOT NULL, retry_at TEXT, lease_until TEXT, job_json TEXT NOT NULL,
      UNIQUE(root_key, source_digest)
    );
  `);
  const insert = database.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, NULL, NULL, ?)");
  for (const job of fixture.jobs) {
    insert.run(
      job.id,
      `${job.rootRef.type}\0${job.rootRef.id}`,
      job.sourceDigest,
      job.status,
      JSON.stringify(job),
    );
  }
  database.close();
  return databasePath;
}
