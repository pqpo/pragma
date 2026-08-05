import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Knowledge learning jobs", () => {
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

    const claimed = await store.claimDueJob(now);
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
    const reclaimed = await store.claimDueJob(new Date(now.getTime() + 6 * 60_000));

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
      now,
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

  it("requires corroboration, a verified fact, or a high-value episode", () => {
    const [episode, semantic] = sources();
    expect(knowledgeSourceSelectionEligible([{ ...episode!, valueScore: 0.84 }])).toBe(false);
    expect(knowledgeSourceSelectionEligible([episode!])).toBe(true);
    expect(knowledgeSourceSelectionEligible([semantic!])).toBe(true);
    expect(
      knowledgeSourceSelectionEligible([
        { ...episode!, valueScore: 0.1 },
        { ...semantic!, verified: false },
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
  return (await store.claimDueJob(now))!;
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
    .map((source) => `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`)
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
