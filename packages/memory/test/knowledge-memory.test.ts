import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";

import type {
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

import {
  createKnowledgeMemoryModule,
  knowledgeSourceSelectionEligible,
  createFileMemoryPolicyStore,
} from "../src/index.ts";
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
  it("does not let an overdue disabled root starve another root", async () => {
    const pragmaHome = await temporaryRoot();
    let clock = now;
    const disabledRoot = ref("pragma.expert", "expert-disabled");
    const enabledRoot = ref("pragma.expert", "expert-a");
    await createFileMemoryPolicyStore({ pragmaHome, now: () => now }).updateOverride({
      targetRef: disabledRoot,
      expectedRevision: 0,
      policy: { capture: "inherit", recall: "inherit", learning: "disabled" },
    });
    const plan = vi.fn(async () => ({ action: "skip" as const }));
    const module = await createKnowledgeMemoryModule({
      pragmaHome,
      now: () => clock,
      sourceReader: { listEligibleSources: async () => sources() },
      planner: { plan },
      learningSink: { listTargets: async () => [knowledgeTarget], submit: vi.fn() },
    });
    try {
      for (const rootRef of [disabledRoot, enabledRoot]) {
        await module.store.schedule({
          rootRef,
          sourceDigest: digestSources(sources()),
          now: new Date(now.getTime() - 24 * 60 * 60_000),
        });
      }
      await module.runBackgroundOnce?.();
      await module.runBackgroundOnce?.();
      expect(plan).toHaveBeenCalledOnce();
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ rootRef: enabledRoot }));
      expect(
        (await module.store.listJobs()).find((job) => job.rootRef.id === disabledRoot.id),
      ).toMatchObject({ status: "pending" });
      clock = new Date(now.getTime() + 6 * 60 * 60_000);
      await createFileMemoryPolicyStore({ pragmaHome, now: () => clock }).updateOverride({
        targetRef: disabledRoot,
        expectedRevision: 1,
        policy: { capture: "inherit", recall: "inherit", learning: "inherit" },
      });
      await module.runBackgroundOnce?.();
      expect(plan).toHaveBeenCalledTimes(2);
      expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({ rootRef: disabledRoot }));
    } finally {
      module.close();
    }
  });

  it.each(["global", "memory", "asset", "during-plan"] as const)(
    "honors disabled learning policy at %s and keeps existing work pending",
    async (boundary) => {
      const pragmaHome = await temporaryRoot();
      const policies = createFileMemoryPolicyStore({ pragmaHome, now: () => now });
      const disable = async () => {
        if (boundary === "asset") {
          await policies.updateOverride({
            targetRef: ref("pragma.expert", "expert-a"),
            expectedRevision: 0,
            policy: { capture: "inherit", recall: "inherit", learning: "disabled" },
          });
        } else {
          const current = await policies.getGlobal();
          await policies.updateGlobal({
            expectedRevision: current.revision,
            policy: {
              ...current.policy,
              ...(boundary === "memory" ? { enabled: "disabled" } : { learning: "disabled" }),
            },
          });
        }
      };
      const plan = vi.fn(async () => {
        if (boundary === "during-plan") await disable();
        return {
          action: "apply" as const,
          ...knowledgePlanFields(),
          name: "Knowledge",
          description: "Guidance",
        };
      });
      const submit = vi.fn(async () => undefined);
      const module = await createKnowledgeMemoryModule({
        pragmaHome,
        now: () => now,
        sourceReader: { listEligibleSources: async () => sources() },
        planner: { plan },
        learningSink: { listTargets: async () => [knowledgeTarget], submit },
      });
      try {
        if (boundary !== "during-plan") await disable();
        if (boundary !== "during-plan") {
          await module.scheduleRoot(ref("pragma.expert", "expert-a"));
          expect(await module.store.listJobs()).toHaveLength(0);
        }
        // Persisted jobs from an earlier version must also obey the current setting.
        await module.store.schedule({
          rootRef: ref("pragma.expert", "expert-a"),
          sourceDigest: digestSources(sources()),
          now: new Date(now.getTime() - 6 * 60 * 60_000),
        });
        await module.runBackgroundOnce?.();
        expect(plan).toHaveBeenCalledTimes(boundary === "during-plan" ? 1 : 0);
        expect(submit).not.toHaveBeenCalled();
        expect((await module.store.listJobs())[0]?.status).toBe("pending");
      } finally {
        module.close();
      }
    },
  );
  it.each(["pending", "running", "needs_attention"] as const)(
    "removes source-less %s jobs before pagination, including after restart",
    async (status) => {
      const pragmaHome = await temporaryRoot();
      const store = await createKnowledgeLearningStore({ pragmaHome });
      const job = await store.schedule({
        rootRef: ref("pragma.expert", "expert-a"),
        sourceDigest,
        now,
      });
      if (status !== "pending") {
        const claim = (await store.claimDueJob(due))!;
        if (status === "needs_attention") {
          await store.fail({
            job: claim,
            diagnostic: failureDiagnostic("missing_configuration"),
            retry: "configuration",
            now: due,
          });
        }
      }
      store.close();
      const plan = vi.fn();
      let available: readonly KnowledgeSourceSnapshot[] = [];
      const module = await createKnowledgeMemoryModule({
        pragmaHome,
        sourceReader: { listEligibleSources: async () => available },
        planner: { plan },
        learningSink: { listTargets: async () => [knowledgeTarget], submit: vi.fn() },
        now: () => now,
      });
      const page = await module.store.listJobsPage({
        statuses: [status],
        limit: 10,
        sortKeyPrefix: "knowledge",
      });
      expect(page).toEqual({ jobs: [], total: 0 });
      await module.runBackgroundOnce?.();
      expect(plan).not.toHaveBeenCalled();
      expect(await module.store.listFailureAttempts(job!.id)).toEqual([]);
      // A later valid source can schedule new work after the obsolete row is removed.
      available = sources();
      await module.scheduleRoot(ref("pragma.expert", "expert-a"));
      expect(await module.store.listJobs()).toHaveLength(1);
      module.close();
    },
  );

  it("discards a running plan when its sources disappear before submission", async () => {
    let available = sources();
    const submit = vi.fn();
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: { listEligibleSources: async () => available },
      planner: {
        plan: async () => {
          available = [];
          return {
            action: "apply",
            ...knowledgePlanFields(),
            name: "Obsolete knowledge",
            description: "Removed source",
          };
        },
      },
      learningSink: { listTargets: async () => [knowledgeTarget], submit },
      now: () => due,
    });
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(available),
      now,
    });
    await module.runBackgroundOnce?.();
    expect(submit).not.toHaveBeenCalled();
    expect(await module.store.listJobs()).toEqual([]);
    module.close();
  });

  it("does not discard a job changed by another claim or a completed job", async () => {
    const store = await createKnowledgeLearningStore({ pragmaHome: await temporaryRoot() });
    const job = (await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest,
      now,
    }))!;
    const claim = (await store.claimDueJob(due))!;
    expect(await store.discardJob({ id: job.id, expectedRevision: job.revision })).toBe(false);
    expect(await store.isClaimCurrent(claim)).toBe(true);
    await store.completeRejected(claim, due);
    const completed = (await store.listJobs())[0]!;
    expect(await store.discardJob({ id: completed.id, expectedRevision: completed.revision })).toBe(
      false,
    );
    store.close();
  });

  it("replaces obsolete work with the remaining eligible sources without another notification", async () => {
    let available = sources();
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: { listEligibleSources: async () => available },
      learningSink: { listTargets: async () => [knowledgeTarget], submit: vi.fn() },
      now: () => now,
    });
    await module.scheduleRoot(ref("pragma.expert", "expert-a"));
    available = available.slice(0, 1);
    const page = await module.store.listJobsPage({
      statuses: ["pending"],
      limit: 10,
      sortKeyPrefix: "knowledge",
    });
    expect(page.total).toBe(1);
    expect(page.jobs[0]!.sourceDigest).toBe(digestSources(available));
    await module.scheduleRoot(ref("pragma.expert", "expert-a"));
    expect(await module.store.listJobs()).toHaveLength(1);
    module.close();
  });

  it("preserves valid queued work and completed history when sources disappear", async () => {
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: {
        listEligibleSources: async ({ rootRef }) => (rootRef.id === "expert-a" ? sources() : []),
      },
      learningSink: { listTargets: async () => [knowledgeTarget], submit: vi.fn() },
      now: () => now,
    });
    await module.store.schedule({ rootRef: ref("pragma.expert", "history"), sourceDigest, now });
    const claim = (await module.store.claimDueJob(due))!;
    await module.store.completeRejected(claim, due);
    await module.scheduleRoot(ref("pragma.expert", "expert-a"));
    expect((await module.store.listJobs()).map((job) => job.status).sort()).toEqual([
      "completed",
      "pending",
    ]);
    module.close();
  });

  it("persists the three-retry budget and five-second deadline across restart", async () => {
    const root = await temporaryRoot();
    let clock = new Date(now.getTime() + 6 * 60 * 60_000);
    let store = await createKnowledgeLearningStore({ pragmaHome: root });
    await store.schedule({
      rootRef: ref("pragma.expert", "expert-retry"),
      sourceDigest: "f".repeat(64),
      now,
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const job = await store.claimDueJob(clock);
      expect(job?.attempts).toBe(attempt);
      await store.fail({
        job: job!,
        diagnostic: {
          schemaVersion: "pragma.memory-extraction-failure/v1",
          code: "temporary_model_failure",
          message: "temporary failure",
          phase: "curator_run",
          retryable: true,
          failedAt: clock.toISOString(),
        },
        retry: "transient",
        now: clock,
      });
      const [failed] = await store.listJobs();
      expect(failed).toMatchObject({
        attempts: attempt,
        status: attempt < 4 ? "pending" : "needs_attention",
      });
      store.close();
      store = await createKnowledgeLearningStore({ pragmaHome: root });
      if (attempt < 4) {
        expect(failed!.retryAt).toBe(new Date(clock.getTime() + 5_000).toISOString());
        clock = new Date(clock.getTime() + 4_999);
        expect(await store.claimDueJob(clock)).toBeUndefined();
        clock = new Date(clock.getTime() + 1);
      } else {
        expect(failed!.retryAt).toBeUndefined();
        clock = new Date(clock.getTime() + 60_000);
        await store.wakeNeedsAttention(clock, "configuration");
        expect(await store.claimDueJob(clock)).toBeUndefined();
      }
    }
    store.close();
  });

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
      diagnostic: {
        ...failureDiagnostic("memory_extractor_profile_invalid"),
        phase: "source_read",
      },
      retry: "configuration",
      now,
    });
    const [attention] = await store.listJobs();
    expect(attention).toMatchObject({
      lastErrorMessage: "memory_extractor_profile_invalid",
      lastFailure: { code: "memory_extractor_profile_invalid", phase: "source_read" },
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
      diagnostic: {
        ...failureDiagnostic("memory_extractor_profile_invalid"),
        phase: "source_read",
      },
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

  it("quarantines expired leases until manual retry and ignores completion from a stale claim", async () => {
    const store = await temporaryStore();
    const first = await claimedJob(store);
    const reclaimed = await store.claimDueJob(new Date(due.getTime() + 6 * 60_000));

    expect(reclaimed).toBeUndefined();
    const [attention] = await store.listJobs();
    expect(attention).toMatchObject({
      id: first.id,
      status: "needs_attention",
      lastFailure: { retryable: false },
    });
    await store.retryJob({ id: attention!.id, expectedRevision: attention!.revision, now });
    expect(await store.claimDueJob(now)).toMatchObject({ id: first.id, status: "running" });
    expect(await store.isClaimCurrent(first)).toBe(false);
    await expect(store.completeRejected(first, now)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    store.close();
  });

  it("retains old completed jobs until they fall outside the count limit", async () => {
    const store = await temporaryStore();
    const job = await claimedJob(store);
    await store.completeRejected(job, now);

    expect(
      await store.pruneCompletedJobs({
        updatedAt: (await store.listJobs())[0]!.updatedAt,
        tieBreaker: `knowledge:${job.id}`,
      }),
    ).toBe(0);
    expect(await store.listJobs()).toHaveLength(1);
    store.close();
  });

  it("routes eligible sources to a revision plan and Host sink", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const plan = {
      action: "apply" as const,
      ...knowledgePlanFields(),
      name: "Memory knowledge",
      description: "Reusable guidance.",
    };
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: { listEligibleSources: async () => sourceRevisions },
      planner: { plan: async () => plan },
      learningSink: { listTargets: async () => [knowledgeTarget], submit },
      now: () => now,
    });
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(sourceRevisions),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });

    await module.runBackgroundOnce?.();

    expect(submit).toHaveBeenCalledWith({
      rootRef: ref("pragma.expert", "expert-a"),
      expertRef: "expert:expert-a",
      sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      plan,
      sources: sourceRevisions,
    });
    expect(await module.store.inspect()).toMatchObject({ jobs: 1, completed: 1 });
    expect(module.store.getPresentation((await module.store.listJobs())[0]!)).toMatchObject({
      titles: [plan.name],
      planned: true,
    });
    module.close();
  });

  it("completes an Agent skip without creating a revision task", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: { listEligibleSources: async () => sourceRevisions },
      planner: { plan: async () => ({ action: "skip" }) },
      learningSink: { listTargets: async () => [knowledgeTarget], submit },
      now: () => now,
    });
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(sourceRevisions),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect(submit).not.toHaveBeenCalled();
    expect(await module.store.inspect()).toMatchObject({ completed: 1 });
    module.close();
  });

  it("parks new evidence while a revision is pending and keeps it wakeable", async () => {
    const sourceRevisions = sources();
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: { listEligibleSources: async () => sourceRevisions },
      planner: {
        plan: async () => ({
          action: "apply",
          ...knowledgePlanFields(),
          name: "Knowledge",
          description: "Reusable guidance.",
        }),
      },
      learningSink: {
        listTargets: async () => [knowledgeTarget],
        submit: async () => {
          throw new Error("memory_revision_pending");
        },
      },
      now: () => now,
    });
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(sourceRevisions),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "needs_attention",
      failureClass: "configuration",
      lastErrorCode: "memory_revision_pending",
    });
    await module.store.wakeNeedsAttention(now, "configuration");
    const [attention] = await module.store.listJobs();
    expect(attention).toMatchObject({
      status: "needs_attention",
      lastFailure: { retryable: false },
    });
    await module.store.retryJob({ id: attention!.id, expectedRevision: attention!.revision, now });
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "pending" });
    expect((await module.store.listJobs())[0]?.attempts).toBe(0);
    module.close();
  });

  it("plans Knowledge separately for eligible producer Experts", async () => {
    const rootRef = ref("pragma.expert-team", "team-a");
    const sourceRevisions = sources().map((source, index) => ({
      ...source,
      rootRef,
      producerRefs: [ref("pragma.expert", index === 0 ? "expert-a" : "expert-b")],
    }));
    const plan = vi.fn(async (input: { sources: readonly KnowledgeSourceSnapshot[] }) => ({
      action: "apply" as const,
      ...knowledgePlanFields(input.sources),
      name: "Team knowledge",
      description: "Reusable knowledge.",
    }));
    const submit = vi.fn(async () => undefined);
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: { listEligibleSources: async () => sourceRevisions },
      planner: { plan },
      learningSink: { listTargets: async () => [knowledgeTarget], submit },
      now: () => now,
    });
    await module.store.schedule({
      rootRef,
      sourceDigest: digestSources(sourceRevisions),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        expertRef: "expert:expert-b",
        sources: [sourceRevisions[1]],
      }),
    );
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        expertRef: "expert:expert-b",
        sources: [sourceRevisions[1]],
      }),
    );
    module.close();
  });

  it("keeps usable sources after an oversized source", async () => {
    const usable = sources();
    const oversized = { ...usable[0]!, body: "x".repeat(410_001) };
    const submit = vi.fn(async () => undefined);
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      sourceReader: { listEligibleSources: async () => [oversized, ...usable] },
      planner: {
        plan: async () => ({
          action: "apply",
          ...knowledgePlanFields(),
          name: "Knowledge",
          description: "Reusable guidance.",
        }),
      },
      learningSink: { listTargets: async () => [knowledgeTarget], submit },
      now: () => now,
    });
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(usable),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ sources: usable }));
    module.close();
  });

  it("admits active Episodes and Facts for value assessment independently of source count", () => {
    const [episode, semantic] = sources();
    expect(knowledgeSourceSelectionEligible([episode!])).toBe(true);
    expect(knowledgeSourceSelectionEligible([])).toBe(false);
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

function digestSources(
  sourceRevisions: readonly KnowledgeSourceSnapshot[],
  policyVersion = "learning-v2",
): string {
  const keys = sourceRevisions
    .map((source) =>
      JSON.stringify({
        kind: source.ref.kind,
        id: source.ref.id,
        producerRefs: source.producerRefs,
        sourceExecutionIds: source.sourceExecutionIds,
        conversationRefs: source.conversationRefs,
        outcome: source.outcome,
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
    .update(["knowledge-sources", ...(policyVersion ? [policyVersion] : []), ...keys].join("\0"))
    .digest("hex");
}

function ref(type: string, id: string): MemorySubjectRef {
  return { type, id };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-knowledge-learning-"));
  roots.push(root);
  await createFileMemoryPolicyStore({
    pragmaHome: root,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  }).updateGlobal({
    expectedRevision: 0,
    policy: {
      enabled: "enabled",
      capture: "enabled",
      recall: "enabled",
      learning: "local-candidates",
    },
  });
  return root;
}

async function temporaryStore(): Promise<KnowledgeLearningStore> {
  return await createKnowledgeLearningStore({ pragmaHome: await temporaryRoot() });
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

it("selects a target before waiting and reuses its validated plan on dependency wakes", async () => {
  let pending = true;
  const plan = vi.fn(async () => ({
    action: "apply" as const,
    name: "Knowledge",
    description: "Migration guidance",
    ...knowledgePlanFields(),
  }));
  const module = await createKnowledgeMemoryModule({
    pragmaHome: await temporaryRoot(),
    sourceReader: { listEligibleSources: async () => sources() },
    planner: { plan },
    learningSink: {
      listTargets: async () => [knowledgeTarget],
      assertAvailable: async () => {
        if (pending) throw new Error("memory_revision_pending");
      },
      submit: vi.fn(),
    },
    now: () => now,
  });
  try {
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(sources()),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
    const [waiting] = await module.store.listJobs();
    expect(waiting).toMatchObject({
      status: "needs_attention",
      lastErrorCode: "memory_revision_pending",
      attempts: 1,
    });
    // Unrelated revision completions must not exhaust a task that has admitted no model.
    for (let wake = 0; wake < 5; wake += 1) {
      await module.store.wakeNeedsAttention(now, "revision-settled");
      await module.runBackgroundOnce?.();
      expect((await module.store.listJobs())[0]).toMatchObject({
        status: "needs_attention",
        attempts: 1,
      });
    }
    expect(plan).toHaveBeenCalledOnce();
    pending = false;
    await module.store.wakeNeedsAttention(now, "revision-settled");
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "pending", attempts: 1 });
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "completed" });
  } finally {
    module.close();
  }
});

it("reopens historical nonretryable revision waits without resetting or exceeding the attempt budget", async () => {
  const pragmaHome = await temporaryRoot();
  let store = await createKnowledgeLearningStore({ pragmaHome });
  try {
    await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: "f".repeat(64),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const job = await store.claimDueJob(now);
      expect(job?.attempts).toBe(attempt);
      await store.fail({
        job: job!,
        retry: "configuration",
        now,
        diagnostic: {
          schemaVersion: "pragma.memory-extraction-failure/v1",
          code: "memory_revision_pending",
          message: "memory_revision_pending",
          phase: "revision_submit",
          failedAt: now.toISOString(),
          retryable: false,
        },
      });
      store.close();
      store = await createKnowledgeLearningStore({ pragmaHome });
      await store.wakeNeedsAttention(now, "configuration");
      expect((await store.listJobs())[0]?.status).toBe("needs_attention");
      await store.wakeNeedsAttention(now, "revision-settled");
      expect((await store.listJobs())[0]).toMatchObject({
        attempts: attempt,
        status: attempt < 4 ? "pending" : "needs_attention",
      });
      if (attempt < 4) {
        const preflight = (await store.claimDueJob(now))!;
        await store.fail({
          job: preflight,
          retry: "configuration",
          modelRequested: false,
          now,
          diagnostic: {
            schemaVersion: "pragma.memory-extraction-failure/v1",
            code: "memory_revision_pending",
            message: "still waiting",
            phase: "revision_submit",
            failedAt: now.toISOString(),
          },
        });
        expect((await store.listJobs())[0]?.attempts).toBe(attempt);
        await store.wakeNeedsAttention(now, "revision-settled");
      }
    }
    expect(await store.claimDueJob(now)).toBeUndefined();
    await store.schedule({
      rootRef: ref("pragma.expert", "expert-b"),
      sourceDigest: "e".repeat(64),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    const failedRuntimeJob = (await store.claimDueJob(now))!;
    await store.fail({
      job: failedRuntimeJob,
      retry: "configuration",
      now,
      diagnostic: {
        schemaVersion: "pragma.memory-extraction-failure/v1",
        code: "runtime_unavailable",
        message: "runtime_unavailable",
        phase: "revision_plan",
        failedAt: now.toISOString(),
        retryable: false,
      },
    });
    await store.wakeNeedsAttention(now, "revision-settled");
    expect(await store.getJob(failedRuntimeJob.id)).toMatchObject({
      status: "needs_attention",
      attempts: 1,
      lastErrorCode: "runtime_unavailable",
    });
  } finally {
    store.close();
  }
});

const knowledgeTarget = {
  storeId: "11111111-1111-4111-8111-111111111111",
  name: "Existing knowledge",
  description: "Migration guidance",
  baseRevision: 1,
  snapshotHash: "f".repeat(64),
  mounted: true,
  body: "Existing migration guide.",
};
function knowledgePlanFields(selected: readonly KnowledgeSourceSnapshot[] = sources()) {
  return {
    rationale: "Add supported migration recovery guidance.",
    sourceRefs: selected.map((source) => source.ref),
    maturity: "incremental" as const,
    target: {
      type: "revise" as const,
      storeId: knowledgeTarget.storeId,
      baseRevision: knowledgeTarget.baseRevision,
      snapshotHash: knowledgeTarget.snapshotHash,
    },
  };
}

it("keeps a single verified fact from creating a knowledge base, then admits a mature cross-conversation topic", async () => {
  const root = await temporaryRoot();
  let available = [
    { ...sources()[1]!, conversationRefs: [ref("pragma.mission", "conversation-a")] },
  ];
  const submit = vi.fn(async () => undefined);
  const module = await createKnowledgeMemoryModule({
    pragmaHome: root,
    now: () => now,
    sourceReader: { listEligibleSources: async () => available },
    learningSink: { submit },
    planner: {
      plan: async ({ sources: selected }) => ({
        action: "apply",
        name: "Migration handbook",
        description: "Stable migration and recovery guidance.",
        rationale: "A coherent reusable migration method.",
        sourceRefs: selected.map((source) => source.ref),
        maturity: "cross-conversation",
        target: {
          type: "create",
          justification:
            "No related editable base exists; independent conversations jointly establish this durable topic.",
        },
      }),
    },
  });
  try {
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(available),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect(submit).not.toHaveBeenCalled();
    expect((await module.store.listJobs())[0]).toMatchObject({
      lastErrorCode: "knowledge_learning_topic_immature",
    });
    available = [
      ...available,
      { ...sources()[0]!, conversationRefs: [ref("pragma.mission", "conversation-b")] },
    ];
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(available),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    module.close();
  }
});

it("does not resubmit the same selected knowledge after unrelated evidence arrives, but accepts a supported new delta", async () => {
  const root = await temporaryRoot();
  let available = [...sources()];
  let selected = [...available];
  const submit = vi.fn(async () => undefined);
  const module = await createKnowledgeMemoryModule({
    pragmaHome: root,
    now: () => now,
    sourceReader: { listEligibleSources: async () => available },
    learningSink: { listTargets: async () => [knowledgeTarget], submit },
    planner: {
      plan: async () => ({
        action: "apply",
        name: "Migration guide",
        description: "Reusable guidance.",
        ...knowledgePlanFields(selected),
      }),
    },
  });
  const run = async () => {
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(available),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
  };
  try {
    await run();
    expect(submit).toHaveBeenCalledTimes(1);
    available = [
      ...available,
      {
        ...sources()[1]!,
        ref: { kind: "semantic", id: "unrelated", revision: 1 },
        body: "Unrelated temporary material.",
      },
    ];
    await run();
    expect(submit).toHaveBeenCalledTimes(1);
    const newSource = {
      ...sources()[1]!,
      ref: { kind: "semantic" as const, id: "new-validation", revision: 1 },
      body: "The migration requires a validated recovery journal before applying changes.",
    };
    available = [...available, newSource];
    selected = [newSource];
    await run();
    expect(submit).toHaveBeenCalledTimes(2);
  } finally {
    module.close();
  }
});

it("preserves decisions for both tasks when a revision-only source update reuses an earlier assessment", async () => {
  let available = [...sources()];
  const plan = vi.fn(async () => ({
    action: "apply" as const,
    name: "Migration guide",
    description: "Verified guidance",
    ...knowledgePlanFields(available),
  }));
  const submit = vi.fn(async () => undefined);
  const module = await createKnowledgeMemoryModule({
    pragmaHome: await temporaryRoot(),
    now: () => now,
    sourceReader: { listEligibleSources: async () => available },
    planner: { plan },
    learningSink: { listTargets: async () => [knowledgeTarget], submit },
  });
  const run = async () => {
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(available),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
  };
  try {
    await run();
    const first = (await module.store.listJobs())[0]!;
    available = available.map((source) => ({
      ...source,
      ref: { ...source.ref, revision: source.ref.revision + 1 },
      observedAt: "2026-08-05T07:00:00.000Z",
    }));
    await run();
    expect(plan).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    const second = (await module.store.listJobs()).find((job) => job.id !== first.id)!;
    expect(module.store.getDecision?.(first)).toMatchObject({ outcome: "revise" });
    expect(module.store.getDecision?.(second)).toMatchObject({ outcome: "duplicate" });
  } finally {
    module.close();
  }
});

it.each(["conversationRefs", "outcome"] as const)(
  "reassesses knowledge when only %s changes",
  async (field) => {
    let available: readonly KnowledgeSourceSnapshot[] = [
      { ...sources()[0]!, outcome: "failed", conversationRefs: [ref("pragma.mission", "first")] },
    ];
    const plan = vi.fn(async () => ({ action: "skip" as const }));
    const module = await createKnowledgeMemoryModule({
      pragmaHome: await temporaryRoot(),
      now: () => now,
      sourceReader: { listEligibleSources: async () => available },
      planner: { plan },
      learningSink: { submit: vi.fn() },
    });
    const run = async () => {
      await module.scheduleRoot(ref("pragma.expert", "expert-a"));
      const pending = (await module.store.listJobs()).find((job) => job.status === "pending");
      if (pending)
        await module.store.expediteJob({ id: pending.id, expectedRevision: pending.revision, now });
      await module.runBackgroundOnce?.();
    };
    try {
      await run();
      available = [
        {
          ...available[0]!,
          ...(field === "outcome"
            ? { outcome: "succeeded" as const }
            : {
                conversationRefs: [ref("pragma.mission", "first"), ref("pragma.mission", "second")],
              }),
        },
      ];
      await run();
      expect(plan).toHaveBeenCalledTimes(2);
    } finally {
      module.close();
    }
  },
);

it("does not submit a Knowledge plan interrupted during target availability checks", async () => {
  const submit = vi.fn(async () => undefined);
  const module = await createKnowledgeMemoryModule({
    pragmaHome: await temporaryRoot(),
    now: () => now,
    sourceReader: { listEligibleSources: async () => sources() },
    planner: {
      plan: async () => ({
        action: "apply",
        name: "Guide",
        description: "Guidance",
        ...knowledgePlanFields(),
      }),
    },
    learningSink: {
      listTargets: async () => [knowledgeTarget],
      submit,
      assertAvailable: async () => {
        const current = (await module.store.listJobs())[0]!;
        await module.interruptExtractionJob({
          id: current.id,
          expectedRevision: current.revision,
          now,
        });
      },
    },
  });
  try {
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(sources()),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
    expect(submit).not.toHaveBeenCalled();
  } finally {
    module.close();
  }
});

it("uses different submission identities when the selected Knowledge target version changes", async () => {
  let target = { ...knowledgeTarget };
  const available = [...sources()];
  const submit = vi.fn<import("../src/knowledge/module.ts").KnowledgeLearningSink["submit"]>(
    async () => undefined,
  );
  const module = await createKnowledgeMemoryModule({
    pragmaHome: await temporaryRoot(),
    now: () => now,
    sourceReader: { listEligibleSources: async () => available },
    planner: {
      plan: async () => ({
        action: "apply",
        name: "Guide",
        description: "Guidance",
        ...knowledgePlanFields(available),
        target: {
          type: "revise",
          storeId: target.storeId,
          baseRevision: target.baseRevision,
          snapshotHash: target.snapshotHash,
        },
      }),
    },
    learningSink: { listTargets: async () => [target], submit },
  });
  const run = async () => {
    await module.store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: digestSources(available),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    await module.runBackgroundOnce?.();
  };
  try {
    await run();
    target = { ...target, baseRevision: 2, snapshotHash: "e".repeat(64) };
    // Completed history may be pruned, while published targets continue evolving.
    await module.store.pruneCompletedJobs({
      updatedAt: "2026-08-06T00:00:00.000Z",
      tieBreaker: "knowledge:z",
    });
    await run();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![0].sourceDigest).not.toBe(submit.mock.calls[0]![0].sourceDigest);
  } finally {
    module.close();
  }
});

it("does not create a decision database while reading a historical task without decisions", async () => {
  const pragmaHome = await temporaryRoot();
  const store = await createKnowledgeLearningStore({ pragmaHome });
  try {
    const job = (await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest,
      now,
    }))!;
    expect(store.getDecision?.(job)).toBeUndefined();
    const path = join(
      new PragmaPaths({ pragmaHome }).memoryModuleDataRoot("pragma.memory.knowledge-learning"),
      "learning-decisions-v1.sqlite",
    );
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    store.close();
  }
});

it.each([0, 1, 2])(
  "rejects a malformed or future decision database at version %i without recreating it",
  async (version) => {
    const { createLearningDecisionStore } = await import("../src/learning/decision-store.ts");
    const pragmaHome = await temporaryRoot();
    const dir = new PragmaPaths({ pragmaHome }).memoryModuleDataRoot(
      "pragma.memory.knowledge-learning",
    );
    await mkdir(dir, { recursive: true });
    const path = join(dir, "learning-decisions-v1.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      `CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('keep'); PRAGMA user_version=${version};`,
    );
    db.close();
    expect(() => createLearningDecisionStore({ pragmaHome }, "knowledge")).toThrow();
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspect.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
      expect(inspect.prepare("SELECT * FROM preserved").all()).toEqual([{ value: "keep" }]);
      expect(
        inspect.prepare("SELECT name FROM sqlite_master WHERE name='decisions'").get(),
      ).toBeUndefined();
    } finally {
      inspect.close();
    }
  },
);

it("reassesses sources completed under the old Knowledge learning policy", async () => {
  const available = sources();
  const plan = vi.fn(async () => ({ action: "skip" as const }));
  const module = await createKnowledgeMemoryModule({
    pragmaHome: await temporaryRoot(),
    now: () => now,
    sourceReader: { listEligibleSources: async () => available },
    planner: { plan },
    learningSink: { submit: vi.fn() },
  });
  try {
    const rootRef = ref("pragma.expert", "expert-a");
    await module.store.schedule({
      rootRef,
      sourceDigest: digestSources(available, ""),
      now: new Date(now.getTime() - 6 * 60 * 60_000),
    });
    const old = (await module.store.claimDueJob(now))!;
    await module.store.completeRejected(old, now);
    await module.scheduleRoot(rootRef);
    const pending = (await module.store.listJobs()).find((job) => job.status === "pending");
    expect(pending).toBeDefined();
    await module.store.expediteJob({ id: pending!.id, expectedRevision: pending!.revision, now });
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
    expect(await module.store.getJob(old.id)).toMatchObject({
      status: "completed",
      completion: "rejected",
    });
  } finally {
    module.close();
  }
});
