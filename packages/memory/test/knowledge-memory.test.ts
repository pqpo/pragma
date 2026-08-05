import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  KnowledgeExtractionJob,
  KnowledgeSourceSnapshot,
  MemorySubjectRef,
} from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";

import {
  createKnowledgeMemoryStore,
  createKnowledgeShare,
  knowledgeSourceSelectionEligible,
  type KnowledgeMemoryStore,
  type MemoryRecallScope,
} from "../src/index.ts";

const roots: string[] = [];
const now = new Date("2026-08-05T08:00:00.000Z");
const sourceDigest = "a".repeat(64);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Knowledge Memory", () => {
  it("expedites, interrupts, retries, and deletes extraction jobs", async () => {
    const store = await temporaryStore();
    await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest,
      now: new Date(now.getTime() - 60_000),
    });
    const [pending] = await store.listJobs();
    await store.expediteJob({ id: pending!.id, expectedRevision: pending!.revision, now });
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
    await store.expediteJob({
      id: interrupted.id,
      expectedRevision: interrupted.revision,
      now,
    });
    const reclaimed = await store.claimDueJob(now);
    await store.fail({
      job: reclaimed!,
      errorCode: "memory_extractor_profile_invalid",
      retry: "configuration",
      now,
    });
    const [attention] = await store.listJobs();
    await store.retryJob({ id: attention!.id, expectedRevision: attention!.revision, now });
    const [retried] = await store.listJobs();
    const rerun = await store.claimDueJob(now);
    await store.fail({
      job: rerun!,
      errorCode: "memory_extractor_profile_invalid",
      retry: "configuration",
      now,
    });
    const [deletable] = await store.listJobs();
    expect(retried?.status).toBe("pending");
    await store.deleteJob({ id: deletable!.id, expectedRevision: deletable!.revision });
    expect(await store.listJobs()).toEqual([]);
    store.close();
  });

  it("keeps candidates out of recall until explicit publication with bindings", async () => {
    const store = await temporaryStore();
    const candidate = await createCandidate(store);
    const scope = recallScope();

    expect(await store.listForRecall(scope)).toEqual([]);

    const published = await store.publishCandidate({
      candidateId: candidate.id,
      expectedRevision: candidate.revision,
      actorRef: ref("pragma.user", "local-user"),
      reason: "Reviewed against both source revisions.",
      bindings: [
        {
          consumerRef: ref("pragma.project", "project-a"),
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
      visibility: { mode: "restricted", principals: [ref("pragma.project", "project-a")] },
      now,
    });

    expect((await store.listForRecall(scope)).map((item) => item.id)).toEqual([published.id]);
    expect((await store.getCandidate(candidate.id))?.state).toBe("published");
    store.close();
  });

  it("creates immutable access and withdrawal revisions while retaining exact history", async () => {
    const store = await temporaryStore();
    const candidate = await createCandidate(store);
    const first = await publish(store, candidate.id, candidate.revision, "allow");
    const tightened = await store.tightenAccess({
      id: first.id,
      expectedRevision: first.revision,
      actorRef: ref("pragma.user", "local-user"),
      reason: "Stop Bundle export.",
      bindings: first.bindings.map((binding) => ({
        ...binding,
        export: "deny",
        permissionRevision: binding.permissionRevision + 1,
      })),
      now: new Date(now.getTime() + 1_000),
    });
    await expect(
      store.listExportable({
        projectRef: ref("pragma.project", "project-a"),
        refs: [{ id: first.id, revision: 1 }],
      }),
    ).rejects.toThrow("knowledge_export_not_allowed");
    const withdrawn = await store.withdraw({
      id: first.id,
      expectedRevision: tightened.revision,
      actorRef: ref("pragma.user", "local-user"),
      reason: "Guidance is no longer applicable.",
      now: new Date(now.getTime() + 2_000),
    });

    expect((await store.history(first.id)).map((item) => item.revision)).toEqual([3, 2, 1]);
    expect((await store.get(first.id, 1))?.bindings[0]?.export).toBe("allow");
    expect(withdrawn.status).toBe("withdrawn");
    expect(await store.listForRecall(recallScope())).toEqual([]);
    store.close();
  });

  it("fails closed for duplicate, missing, inactive, and prohibited export revisions", async () => {
    const store = await temporaryStore();
    const candidate = await createCandidate(store);
    const published = await publish(store, candidate.id, candidate.revision, "allow");
    const requested = { id: published.id, revision: published.revision };

    await expect(
      store.listExportable({
        projectRef: ref("pragma.project", "project-a"),
        refs: [requested, requested],
      }),
    ).rejects.toThrow("knowledge_export_duplicate_revision");
    await expect(
      store.listExportable({
        projectRef: ref("pragma.project", "project-a"),
        refs: [{ id: published.id, revision: published.revision + 100 }],
      }),
    ).rejects.toThrow("knowledge_export_revision_missing");

    const withdrawn = await store.withdraw({
      id: published.id,
      expectedRevision: published.revision,
      actorRef: ref("pragma.user", "local-user"),
      reason: "No longer applicable.",
      now: new Date(now.getTime() + 1_000),
    });
    await expect(
      store.listExportable({
        projectRef: ref("pragma.project", "project-a"),
        refs: [requested],
      }),
    ).rejects.toThrow("knowledge_export_inactive");
    expect(withdrawn.status).toBe("withdrawn");
    store.close();

    const privateStore = await temporaryStore();
    const privateCandidate = await createCandidate(privateStore);
    const privateKnowledge = await privateStore.publishCandidate({
      candidateId: privateCandidate.id,
      expectedRevision: privateCandidate.revision,
      actorRef: ref("pragma.user", "local-user"),
      reason: "Reviewed for local use only.",
      bindings: [
        {
          consumerRef: ref("pragma.project", "project-a"),
          recall: "allow",
          export: "allow",
          permissionRevision: 1,
        },
      ],
      visibility: { mode: "host-private" },
      now,
    });
    await expect(
      privateStore.listExportable({
        projectRef: ref("pragma.project", "project-a"),
        refs: [{ id: privateKnowledge.id, revision: privateKnowledge.revision }],
      }),
    ).rejects.toThrow("knowledge_export_prohibited");
    privateStore.close();
  });

  it("does not regenerate rejected source digests", async () => {
    const store = await temporaryStore();
    const job = await claimedJob(store);
    await store.completeRejected(job, now);

    expect(
      await store.schedule({
        rootRef: ref("pragma.expert", "expert-a"),
        sourceDigest,
        now: new Date(now.getTime() + 1_000),
      }),
    ).toBeUndefined();
    store.close();
  });

  it("requires corroboration, a verified fact, or a high-value episode", () => {
    const [episode, semantic] = sources();
    expect(episode).toBeDefined();
    expect(semantic).toBeDefined();
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

  it("reclaims a running extraction job after its durable lease expires", async () => {
    const store = await temporaryStore();
    const first = await claimedJob(store);
    const reclaimed = await store.claimDueJob(new Date(now.getTime() + 6 * 60_000));

    expect(reclaimed).toMatchObject({
      id: first.id,
      revision: first.revision + 1,
      status: "running",
    });
    store.close();
  });

  it("imports a share idempotently, preserves export permission, and rejects tampering", async () => {
    const source = await temporaryStore();
    const candidate = await createCandidate(source);
    const published = await publish(source, candidate.id, candidate.revision, "allow");
    const share = createKnowledgeShare({
      knowledge: published,
      sourceProjectFingerprint: "project-fingerprint-a",
      provenance: published.sourceRefs.map((sourceRef) => ({
        sourceKind: sourceRef.kind,
        sourceId: sourceRef.id,
        sourceRevision: sourceRef.revision,
        summary: "Reviewed source revision.",
      })),
    });
    const target = await temporaryStore();
    const mapRef = (value: MemorySubjectRef) =>
      value.type === "pragma.project" ? ref("pragma.project", "project-b") : value;

    const first = await target.importShares({
      shares: [share],
      mapRef,
      actorRef: ref("pragma.user", "local-user"),
      now,
    });
    const second = await target.importShares({
      shares: [share],
      mapRef,
      actorRef: ref("pragma.user", "local-user"),
      now,
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(first[0]?.bindings).toContainEqual({
      consumerRef: ref("pragma.project", "project-b"),
      recall: "allow",
      export: "allow",
      permissionRevision: 1,
    });
    const successorCandidate = await source.createSuccessor({
      knowledgeId: published.id,
      expectedRevision: published.revision,
      content: {
        ...published.content,
        summary: "Persistent schema changes require adjacent migrations and recovery tests.",
      },
      actorRef: ref("pragma.user", "local-user"),
      now: new Date(now.getTime() + 1_000),
    });
    const successor = await source.publishCandidate({
      candidateId: successorCandidate.id,
      expectedRevision: successorCandidate.revision,
      actorRef: ref("pragma.user", "local-user"),
      reason: "Reviewed successor.",
      bindings: published.bindings,
      visibility: published.visibility,
      now: new Date(now.getTime() + 2_000),
    });
    const successorShare = createKnowledgeShare({
      knowledge: successor,
      sourceProjectFingerprint: "project-fingerprint-a",
      provenance: successor.sourceRefs.map((sourceRef) => ({
        sourceKind: sourceRef.kind,
        sourceId: sourceRef.id,
        sourceRevision: sourceRef.revision,
        summary: "Reviewed source revision.",
      })),
    });
    const upgraded = await target.importShares({
      shares: [successorShare],
      mapRef,
      actorRef: ref("pragma.user", "local-user"),
      now: new Date(now.getTime() + 3_000),
    });
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).toMatchObject({ revision: 2, content: successor.content });
    await expect(
      target.importShares({
        shares: [{ ...share, content: { ...share.content, summary: "tampered" } }],
        mapRef,
        actorRef: ref("pragma.user", "local-user"),
        now,
      }),
    ).rejects.toThrow("knowledge_import_digest_mismatch");
    source.close();
    target.close();
  });

  it("rolls back every imported revision when a later share is invalid", async () => {
    const source = await temporaryStore();
    const candidate = await createCandidate(source);
    const published = await publish(source, candidate.id, candidate.revision, "allow");
    const provenance = published.sourceRefs.map((sourceRef) => ({
      sourceKind: sourceRef.kind,
      sourceId: sourceRef.id,
      sourceRevision: sourceRef.revision,
      summary: "Reviewed source revision.",
    }));
    const valid = createKnowledgeShare({
      knowledge: published,
      sourceProjectFingerprint: "project-fingerprint-a",
      provenance,
    });
    const invalid = createKnowledgeShare({
      knowledge: {
        ...published,
        id: "knowledge-with-unmapped-root",
        rootRef: ref("pragma.project", "project-unmapped"),
      },
      sourceProjectFingerprint: "project-fingerprint-a",
      provenance,
    });
    const target = await temporaryStore();

    await expect(
      target.importShares({
        shares: [valid, invalid],
        mapRef: (value) => {
          if (value.type === "pragma.project" && value.id === "project-a") {
            return ref("pragma.project", "project-b");
          }
          if (value.type === "pragma.project") return undefined;
          return value;
        },
        actorRef: ref("pragma.user", "local-user"),
        now,
      }),
    ).rejects.toThrow("knowledge_import_root_unmapped");
    expect(await target.list()).toEqual([]);

    source.close();
    target.close();
  });
});

async function createCandidate(store: KnowledgeMemoryStore) {
  const job = await claimedJob(store);
  const candidates = await store.completeCandidates({
    job,
    candidates: [
      {
        content: {
          title: "Verify migrations before changing schemas",
          summary: "Persistent schema changes must ship with an executable adjacent migration.",
          guidance: ["Add a historical fixture.", "Exercise crash recovery before merging."],
          normalizedKey: "storage.schema-migration",
        },
        sourceRefs: sources().map((source) => source.ref),
      },
    ],
    sources: sources(),
    provenance: {
      curatorRef: "pragma.memory.curator",
      promptVersion: "knowledge-curator/v1",
      profileRevision: 1,
      runtimeId: "runtime-a",
      providerId: "provider-a",
      modelId: "model-a",
      extractedAt: now.toISOString(),
    },
    now,
  });
  return candidates[0]!;
}

async function claimedJob(store: KnowledgeMemoryStore): Promise<KnowledgeExtractionJob> {
  await store.schedule({
    rootRef: ref("pragma.expert", "expert-a"),
    sourceDigest,
    now,
  });
  return (await store.claimDueJob(now))!;
}

async function publish(
  store: KnowledgeMemoryStore,
  id: string,
  revision: number,
  exportAccess: "allow" | "deny",
) {
  return await store.publishCandidate({
    candidateId: id,
    expectedRevision: revision,
    actorRef: ref("pragma.user", "local-user"),
    reason: "Reviewed.",
    bindings: [
      {
        consumerRef: ref("pragma.project", "project-a"),
        recall: "allow",
        export: exportAccess,
        permissionRevision: 1,
      },
    ],
    visibility: { mode: "restricted", principals: [ref("pragma.project", "project-a")] },
    now,
  });
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

function recallScope(): MemoryRecallScope {
  return {
    rootRef: ref("pragma.expert", "expert-a") as MemoryRecallScope["rootRef"],
    expertRef: ref("pragma.expert", "expert-a") as MemoryRecallScope["expertRef"],
    principalRefs: [ref("pragma.project", "project-a")],
  };
}

function ref(type: string, id: string): MemorySubjectRef {
  return { type, id };
}

async function temporaryStore(): Promise<KnowledgeMemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "pragma-knowledge-"));
  roots.push(root);
  return await createKnowledgeMemoryStore({ pragmaHome: root });
}
