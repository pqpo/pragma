import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import type { MemorySubjectRef, SkillLearningJob, SkillSourceSnapshot } from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFileMemoryPolicyStore,
  createSkillMemoryModule,
  type SkillLearningSink,
} from "../src/index.ts";
import {
  initializeExtractionFailureAttempts,
  insertExtractionFailureAttempt,
} from "../src/pipeline/extraction-failure-store.ts";
import { createSkillLearningStore } from "../src/skill/store.ts";

const roots: string[] = [];
const now = new Date("2026-08-05T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Skill learning revision planning", () => {
  it("keeps terminal delivery successful when optional title sources cannot be read", async () => {
    const sourceReader = {
      listEligibleSources: vi.fn(async () => {
        throw new Error("source unavailable");
      }),
    };
    const module = await createSkillMemoryModule({
      pragmaHome: await temporaryRoot(),
      now: () => now,
      sourceReader,
      targetReader: { listTargets: async () => [] },
      learningSink: { submit: vi.fn() },
    });
    try {
      await expect(
        module.consume([
          {
            topic: "execution.execution.terminal",
            messageId: "terminal",
            attribution: { rootRef: ref("pragma.expert", "expert-a") },
          } as unknown as import("@pragma/shared").MemoryEvidenceEnvelope,
        ]),
      ).resolves.toEqual({});
      expect(sourceReader.listEligibleSources).toHaveBeenCalledOnce();
      expect(await module.store.listJobs()).toHaveLength(1);
    } finally {
      module.close();
    }
  });

  it.each(["global", "memory", "asset", "during-plan"] as const)(
    "honors disabled learning policy at %s before planning or submitting",
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
          changes: [
            {
              name: "Workflow",
              description: "Reusable workflow",
              normalizedKey: "workflow.example",
              sourceRefs: sources()
                .slice(0, 3)
                .map((source) => source.ref),
              target: { type: "create" as const },
            },
          ],
        };
      });
      const submit = vi.fn(async () => undefined);
      const module = await createModule(sources(), { pragmaHome, plan, submit });
      try {
        if (boundary !== "during-plan") await disable();
        await schedule(module, sources());
        await module.runBackgroundOnce?.();
        expect(plan).toHaveBeenCalledTimes(boundary === "during-plan" ? 1 : 0);
        expect(submit).not.toHaveBeenCalled();
        expect((await module.store.listJobs())[0]?.status).toBe("pending");
      } finally {
        module.close();
      }
    },
  );
  it("persists the three-retry budget and five-second deadline across restart", async () => {
    const root = await temporaryRoot();
    let clock = new Date(now.getTime() + 6 * 60 * 60_000);
    let store = await createSkillLearningStore({ pragmaHome: root });
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
      store = await createSkillLearningStore({ pragmaHome: root });
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

  it("completes supporting facts without executed workflow evidence without invoking the Agent", async () => {
    const plan = vi.fn(async () => ({ action: "skip" as const }));
    const module = await createModule(sources().slice(3), { plan });
    await schedule(module, sources().slice(3));
    await module.runBackgroundOnce?.();
    expect(plan).not.toHaveBeenCalled();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "rejected",
    });
    module.close();
  });

  it("submits a validated revision plan with three cited Episodes", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const plan = {
      action: "apply" as const,
      changes: [
        {
          name: "Workflow",
          description: "A reusable workflow.",
          normalizedKey: "workflow.example",
          sourceRefs: sourceRevisions.slice(0, 3).map((source) => source.ref),
          target: { type: "create" as const },
        },
      ],
    };
    const module = await createModule(sourceRevisions, { plan: async () => plan, submit });
    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        expertRef: "expert:expert-a",
        plan,
      }),
    );
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "retained",
    });
    module.close();
  });

  it("completes an invented source proposal without retrying the model", async () => {
    const sourceRevisions = sources();
    const module = await createModule(sourceRevisions, {
      plan: async () => ({
        action: "apply",
        changes: [
          {
            name: "Workflow",
            description: "A reusable workflow.",
            normalizedKey: "workflow.invalid",
            sourceRefs: [
              ...sourceRevisions.slice(0, 2).map((source) => source.ref),
              { kind: "episodic" as const, id: "missing", revision: 1 },
            ],
            target: { type: "create" },
          },
        ],
      }),
    });
    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "rejected",
      attempts: 1,
    });
    module.close();
  });

  it("submits qualifying changes even when other changes lack successful workflow evidence", async () => {
    const revisions = sources();
    const low = {
      ...revisions[2]!,
      ref: { kind: "episodic" as const, id: "low", revision: 1 },
      valueScore: 0.8,
      outcome: "failed" as const,
    };
    const change = {
      name: "Workflow",
      description: "Reusable workflow",
      normalizedKey: "workflow.good",
      sourceRefs: revisions.slice(0, 3).map((source) => source.ref),
      target: { type: "create" as const },
    };
    const submit = vi.fn(async () => undefined);
    const module = await createModule([...revisions, low], {
      submit,
      plan: async () => ({
        action: "apply",
        changes: [
          {
            ...change,
            normalizedKey: "workflow.bad",
            sourceRefs: [low.ref],
          },
          change,
        ],
      }),
    });
    try {
      await schedule(module, [...revisions, low]);
      await module.runBackgroundOnce?.();
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({ plan: { action: "apply", changes: [change] } }),
      );
      expect((await module.store.listJobs())[0]).toMatchObject({
        status: "completed",
        completion: "retained",
        attempts: 1,
      });
    } finally {
      module.close();
    }
  });

  it("completes without retry when every proposed Skill lacks a succeeded Episode", async () => {
    const revisions = sources();
    const low = {
      ...revisions[2]!,
      ref: { kind: "episodic" as const, id: "low", revision: 1 },
      valueScore: 0.8,
      outcome: "failed" as const,
    };
    const submit = vi.fn(async () => undefined);
    const module = await createModule([...revisions, low], {
      submit,
      plan: async () => ({
        action: "apply",
        changes: [
          {
            name: "Workflow",
            description: "Reusable workflow",
            normalizedKey: "workflow.bad",
            sourceRefs: [low.ref],
            target: { type: "create" },
          },
        ],
      }),
    });
    try {
      await schedule(module, [...revisions, low]);
      await module.runBackgroundOnce?.();
      expect(submit).not.toHaveBeenCalled();
      expect((await module.store.listJobs())[0]).toMatchObject({
        status: "completed",
        completion: "rejected",
        attempts: 1,
      });
      expect(await module.store.claimDueJob(new Date(now.getTime() + 60_000))).toBeUndefined();
      const [job] = await module.store.listJobs();
      expect(await module.store.listFailureAttempts(job!.id)).toEqual([
        expect.objectContaining({
          diagnostic: expect.objectContaining({
            code: "skill_learning_plan_rejected",
            phase: "validation",
            message: expect.stringContaining("at least one succeeded Episode"),
          }),
        }),
      ]);
    } finally {
      module.close();
    }
  });

  it("records rejected changes reported by the planner even when it returns skip", async () => {
    const module = await createModule(sources(), {
      plan: async ({ onRejectedChanges }) => {
        onRejectedChanges?.([
          { index: 0, message: "Insufficient high-value citations after correction." },
        ]);
        return { action: "skip" };
      },
    });
    try {
      await schedule(module, sources());
      await module.runBackgroundOnce?.();
      const [job] = await module.store.listJobs();
      expect(job).toMatchObject({ status: "completed", completion: "rejected" });
      expect(await module.store.listFailureAttempts(job!.id)).toEqual([
        expect.objectContaining({
          diagnostic: expect.objectContaining({
            code: "skill_learning_plan_rejected",
            message: expect.stringContaining("after correction"),
          }),
        }),
      ]);
    } finally {
      module.close();
    }
  });

  it("rolls back diagnostic insertion when completion cannot commit", async () => {
    const pragmaHome = await temporaryRoot();
    const store = await createSkillLearningStore({ pragmaHome });
    const databasePath = join(
      new PragmaPaths({ pragmaHome }).memoryModuleDataRoot("pragma.memory.skill-learning"),
      "skill-learning.sqlite",
    );
    const database = new DatabaseSync(databasePath);
    try {
      await store.schedule({
        rootRef: ref("pragma.expert", "expert-a"),
        sourceDigest: "d".repeat(64),
        now,
      });
      const job = (await store.claimDueJob(now))!;
      const diagnostic = {
        schemaVersion: "pragma.memory-extraction-failure/v1" as const,
        code: "skill_learning_plan_rejected",
        message: "Rejected proposal",
        phase: "validation" as const,
        failedAt: now.toISOString(),
        retryable: false,
      };
      database.exec(
        `CREATE TRIGGER abort_completion BEFORE UPDATE OF status ON jobs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'completion interrupted'); END;`,
      );
      await expect(store.complete(job, "rejected", now, diagnostic)).rejects.toThrow(
        "completion interrupted",
      );
      expect(await store.getJob(job.id)).toEqual(job);
      expect(await store.listFailureAttempts(job.id)).toEqual([]);
      database.exec("DROP TRIGGER abort_completion");
      await store.complete(job, "rejected", now, diagnostic);
      expect(await store.getJob(job.id)).toMatchObject({
        status: "completed",
        completion: "rejected",
      });
      expect(await store.listFailureAttempts(job.id)).toHaveLength(1);
      await expect(store.complete(job, "rejected", now, diagnostic)).rejects.toThrow(
        "skill_job_conflict",
      );
      expect(await store.listFailureAttempts(job.id)).toHaveLength(1);
    } finally {
      database.close();
      store.close();
    }
  });

  it("parks new evidence while a Skill revision is pending and keeps it wakeable", async () => {
    const sourceRevisions = sources();
    const module = await createModule(sourceRevisions, {
      plan: async () => ({
        action: "apply",
        changes: [
          {
            name: "Workflow",
            description: "A reusable workflow.",
            normalizedKey: "workflow.example",
            sourceRefs: sourceRevisions.slice(0, 3).map((source) => source.ref),
            target: { type: "create" },
          },
        ],
      }),
      submit: async () => {
        throw new Error("memory_revision_pending");
      },
    });
    await schedule(module, sourceRevisions);
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

  it("keeps the first valid change when a later change repeats its Skill identity", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const change = {
      name: "Workflow",
      description: "A reusable workflow.",
      normalizedKey: "workflow.duplicate",
      sourceRefs: sourceRevisions.slice(0, 3).map((source) => source.ref),
      target: { type: "create" as const },
    };
    const module = await createModule(sourceRevisions, {
      plan: async () => ({ action: "apply", changes: [change, change] }),
      submit,
    });
    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ plan: { action: "apply", changes: [change] } }),
    );
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "retained",
      attempts: 1,
    });
    module.close();
  });

  it("rejects revising a target owned by another Skill identity", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const module = await createModule(sourceRevisions, {
      plan: async () => ({
        action: "apply",
        changes: [
          {
            name: "Workflow",
            description: "A reusable workflow.",
            normalizedKey: "workflow.conflict",
            sourceRefs: sourceRevisions.slice(0, 3).map((source) => source.ref),
            target: { type: "revise", capabilityId: "1h2j3k4m5n6p7q8r" },
          },
        ],
      }),
      submit,
      targets: [
        {
          bindingId: "binding-old",
          capabilityId: "1h2j3k4m5n6p7q8r",
          name: "Old workflow",
          description: "Existing Skill",
          normalizedKeys: ["workflow.old"],
        },
        {
          bindingId: "binding-other",
          capabilityId: "2h3j4k5m6n7p8q9r",
          name: "Other workflow",
          description: "Another Skill",
          normalizedKeys: ["workflow.conflict"],
        },
      ],
    });
    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();
    expect(submit).not.toHaveBeenCalled();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "rejected",
      attempts: 1,
    });
    module.close();
  });

  it("allows an existing Skill to learn a new normalized key", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const change = {
      name: "Expanded workflow",
      description: "A new workflow in an existing Skill",
      normalizedKey: "workflow.new",
      sourceRefs: sourceRevisions.slice(0, 3).map((source) => source.ref),
      target: { type: "revise" as const, capabilityId: "1h2j3k4m5n6p7q8r" },
    };
    const module = await createModule(sourceRevisions, {
      plan: async () => ({ action: "apply", changes: [change] }),
      submit,
      targets: [
        {
          bindingId: "binding-old",
          capabilityId: change.target.capabilityId,
          name: "Existing Skill",
          description: "Reusable workflows",
          normalizedKeys: ["workflow.old"],
        },
      ],
    });
    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ plan: { action: "apply", changes: [change] } }),
    );
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "retained",
    });
    module.close();
  });
});

describe("Skill learning store migration chain", () => {
  it("archives historical threshold attention as rejected and preserves other failures", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeLegacyStore(root);

    const store = await createSkillLearningStore({ pragmaHome: root });
    const jobs = await store.listJobs();
    const threshold = jobs.find((job) => job.id === "threshold-job");
    expect(threshold).toMatchObject({
      revision: 5,
      status: "completed",
      completion: "rejected",
    });
    expect(threshold).not.toHaveProperty("lastErrorCode");
    expect(threshold).not.toHaveProperty("failureClass");
    expect(jobs.find((job) => job.id === "configuration-job")).toMatchObject({
      revision: 2,
      status: "needs_attention",
      lastErrorCode: "memory_extractor_profile_invalid",
      failureClass: "configuration",
    });
    expect(jobs.find((job) => job.id === "target-binding-job")).toMatchObject({
      revision: 3,
      status: "pending",
      attempts: 0,
      retryAt: "2026-08-05T08:00:02.000Z",
    });
    expect(await store.inspect()).toMatchObject({ needsAttention: 1, pending: 1, completed: 1 });
    store.close();

    const migrated = new DatabaseSync(databasePath);
    expect(
      (migrated.prepare("SELECT version FROM schema_meta").get() as { version: number }).version,
    ).toBe(5);
    migrated.close();
    await expect(stat(`${databasePath}.v1.backup`)).resolves.toBeDefined();
  });

  it("opens current v5 storage without rewriting jobs", async () => {
    const root = await temporaryRoot();
    const store = await createSkillLearningStore({ pragmaHome: root });
    const scheduled = await store.schedule({
      rootRef: ref("pragma.expert", "expert-a"),
      sourceDigest: "c".repeat(64),
      now,
    });
    store.close();

    const reopened = await createSkillLearningStore({ pragmaHome: root });
    expect(await reopened.listJobs()).toEqual([scheduled]);
    reopened.close();
  });

  it("upgrades a v2 store directly and preserves its backup", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeStoreFixture(root, 2, "skill-learning-store-v2.json");

    const store = await createSkillLearningStore({ pragmaHome: root });
    expect((await store.listJobs()).find((job) => job.id === "duplicate-job")).toMatchObject({
      revision: 4,
      status: "pending",
      attempts: 0,
      retryAt: "2026-08-05T08:00:03.000Z",
    });
    expect((await store.listJobs()).find((job) => job.id === "configuration-job")).toMatchObject({
      status: "needs_attention",
      failureClass: "configuration",
    });
    store.close();
    await expect(stat(`${databasePath}.v2.backup`)).resolves.toBeDefined();
  });

  it("rolls back an interrupted migration and replays it after the fault is removed", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeLegacyStore(root);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER abort_candidate_migration
      BEFORE UPDATE OF status ON jobs
      WHEN NEW.id = 'target-binding-job'
      BEGIN
        SELECT RAISE(ABORT, 'simulated migration interruption');
      END;
    `);
    database.close();

    await expect(createSkillLearningStore({ pragmaHome: root })).rejects.toThrow(
      "simulated migration interruption",
    );
    const interrupted = new DatabaseSync(databasePath);
    expect(
      (interrupted.prepare("SELECT version FROM schema_meta").get() as { version: number }).version,
    ).toBe(2);
    expect(
      interrupted.prepare("SELECT status FROM jobs WHERE id='target-binding-job'").get(),
    ).toEqual({
      status: "needs_attention",
    });
    interrupted.exec("DROP TRIGGER abort_candidate_migration;");
    interrupted.close();

    const recovered = await createSkillLearningStore({ pragmaHome: root });
    expect(
      (await recovered.listJobs()).find((job) => job.id === "target-binding-job"),
    ).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    recovered.close();
  });

  it("rejects a future storage version", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeLegacyStore(root);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE schema_meta SET version=6").run();
    database.close();

    await expect(createSkillLearningStore({ pragmaHome: root })).rejects.toThrow(
      "Unsupported pragma.memory-skill-learning-store version.",
    );
  });
});

describe("Skill learning store v4 to v5 settlement", () => {
  it("settles historical invalid proposals without model replay and preserves diagnostics", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeStoreFixture(root, 4, "skill-learning-store-v4.json");
    const store = await createSkillLearningStore({ pragmaHome: root });
    const jobs = await store.listJobs();
    for (const job of jobs.filter((job) => job.status === "completed")) {
      expect(job).toMatchObject({ completion: "rejected" });
      expect(job.lastFailure).toBeUndefined();
      expect(await store.listFailureAttempts(job.id)).not.toHaveLength(0);
    }
    expect(await store.inspect()).toMatchObject({ completed: 2, pending: 0, needsAttention: 1 });
    expect(jobs.find((job) => job.status === "needs_attention")).toMatchObject({
      lastErrorCode: "runtime_unavailable",
      attempts: 1,
    });
    expect(await store.claimDueJob(new Date("2026-10-23T00:00:00.000Z"))).toBeUndefined();
    store.close();
    const reopened = await createSkillLearningStore({ pragmaHome: root });
    expect(await reopened.listJobs()).toEqual(jobs);
    reopened.close();
    await expect(stat(`${databasePath}.v4.backup`)).resolves.toBeDefined();
  });

  it.each([true, false])(
    "preserves the last diagnostic when history is absent (structured=%s)",
    async (structured) => {
      const root = await temporaryRoot();
      const databasePath = await writeStoreFixture(root, 4, "skill-learning-store-v4.json");
      const database = new DatabaseSync(databasePath);
      database.exec("DELETE FROM job_failure_attempts");
      if (!structured)
        database.exec("UPDATE jobs SET job_json=json_remove(job_json, '$.lastFailure')");
      database.close();
      const store = await createSkillLearningStore({ pragmaHome: root });
      let jobs: readonly SkillLearningJob[];
      let attempts: readonly (readonly import("@pragma/shared").MemoryExtractionFailureAttempt[])[];
      try {
        for (const job of (await store.listJobs()).filter((job) => job.status === "completed")) {
          expect(await store.listFailureAttempts(job.id)).toEqual([
            expect.objectContaining({
              diagnostic: expect.objectContaining({
                phase: "validation",
                code: expect.stringMatching(/^skill_learning_plan_/u),
              }),
            }),
          ]);
        }
        jobs = await store.listJobs();
        attempts = await Promise.all(jobs.map((job) => store.listFailureAttempts(job.id)));
      } finally {
        store.close();
      }
      const reopened = await createSkillLearningStore({ pragmaHome: root });
      try {
        expect(await Promise.all(jobs.map((job) => reopened.listFailureAttempts(job.id)))).toEqual(
          attempts,
        );
      } finally {
        reopened.close();
      }
    },
  );

  it("rolls back interrupted settlement and completes it on the next open", async () => {
    const root = await temporaryRoot();
    const databasePath = await writeStoreFixture(root, 4, "skill-learning-store-v4.json");
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TRIGGER abort_settlement BEFORE UPDATE OF status ON jobs
      WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'settlement interrupted'); END;`);
    database.close();
    await expect(createSkillLearningStore({ pragmaHome: root })).rejects.toThrow(
      "settlement interrupted",
    );
    const interrupted = new DatabaseSync(databasePath);
    expect(interrupted.prepare("SELECT version FROM schema_meta").get()).toEqual({ version: 4 });
    expect(
      interrupted.prepare("SELECT count(*) AS count FROM jobs WHERE status='completed'").get(),
    ).toEqual({ count: 0 });
    interrupted.exec("DROP TRIGGER abort_settlement");
    interrupted.close();
    const recovered = await createSkillLearningStore({ pragmaHome: root });
    expect(await recovered.inspect()).toMatchObject({ completed: 2, needsAttention: 1 });
    recovered.close();
  });
});

async function createModule(
  sourceRevisions: readonly SkillSourceSnapshot[],
  overrides: {
    readonly pragmaHome?: string;
    readonly plan: NonNullable<Parameters<typeof createSkillMemoryModule>[0]["planner"]>["plan"];
    readonly submit?: SkillLearningSink["submit"];
    readonly targets?: readonly import("@pragma/shared").ExistingMemorySkillTarget[];
  },
) {
  return await createSkillMemoryModule({
    pragmaHome: overrides.pragmaHome ?? (await temporaryRoot()),
    sourceReader: { listEligibleSources: async () => sourceRevisions },
    targetReader: { listTargets: async () => overrides.targets ?? [] },
    planner: { plan: overrides.plan },
    learningSink: { submit: overrides.submit ?? vi.fn(async () => undefined) },
    now: () => now,
  });
}

async function schedule(
  module: Awaited<ReturnType<typeof createSkillMemoryModule>>,
  sourceRevisions: readonly SkillSourceSnapshot[],
): Promise<void> {
  await module.store.schedule({
    rootRef: ref("pragma.expert", "expert-a"),
    sourceDigest: digestSources(sourceRevisions),
    now,
  });
}

function sources(): readonly SkillSourceSnapshot[] {
  return [
    episode("episode-a", "mission-a", "succeeded"),
    episode("episode-b", "mission-a", "succeeded"),
    episode("episode-c", "mission-b", "failed"),
    {
      ref: { kind: "semantic", id: "fact-a", revision: 1 },
      rootRef: ref("pragma.expert", "expert-a"),
      producerRefs: [ref("pragma.expert", "expert-a")],
      sourceExecutionIds: ["execution-fact"],
      title: "Supporting fact",
      body: "A supporting fact that cannot satisfy the Skill threshold.",
      outcome: "supporting",
      hasSuccessfulRecovery: false,
      observedAt: "2026-08-04T09:00:00.000Z",
      verified: true,
      visibility: { mode: "host-private" },
      sensitivity: "internal",
    },
  ];
}

function episode(
  id: string,
  conversationId: string,
  outcome: SkillSourceSnapshot["outcome"],
  expertId = "expert-a",
): SkillSourceSnapshot {
  return {
    ref: { kind: "episodic", id, revision: 1 },
    rootRef: ref("pragma.expert", expertId),
    conversationRef: ref("pragma.mission", conversationId),
    sourceExecutionIds: [`execution-${id}`],
    producerRefs: [ref("pragma.expert", expertId)],
    title: `Episode ${id}`,
    body: "A reusable multi-step workflow was completed.",
    outcome,
    hasSuccessfulRecovery: false,
    observedAt: "2026-08-04T08:00:00.000Z",
    verified: true,
    valueScore: 0.9,
    visibility: { mode: "host-private" },
    sensitivity: "internal",
  };
}

function digestSources(
  sourceRevisions: readonly SkillSourceSnapshot[],
  policyVersion = "learning-v2",
): string {
  const keys = sourceRevisions
    .map((source) => `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`)
    .toSorted();
  return createHash("sha256")
    .update(["skill-sources", ...(policyVersion ? [policyVersion] : []), ...keys].join("\0"))
    .digest("hex");
}

async function writeLegacyStore(root: string): Promise<string> {
  return await writeStoreFixture(root, 1, "skill-learning-store-v1.json");
}

async function writeStoreFixture(
  root: string,
  version: number,
  fixtureName: string,
): Promise<string> {
  const dataRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot(
    "pragma.memory.skill-learning",
  );
  await mkdir(dataRoot, { recursive: true });
  const databasePath = join(dataRoot, "skill-learning.sqlite");
  const fixture = JSON.parse(
    await readFile(new URL(`./fixtures/${fixtureName}`, import.meta.url), "utf8"),
  ) as {
    readonly jobs: readonly SkillLearningJob[];
    readonly failures?: readonly import("@pragma/shared").MemoryExtractionFailureAttempt[];
  };
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) VALUES (${version});
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
  initializeExtractionFailureAttempts(database);
  for (const failure of fixture.failures ?? []) insertExtractionFailureAttempt(database, failure);
  database.close();
  return databasePath;
}

function ref(type: string, id: string): MemorySubjectRef {
  return { type, id };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-skill-learning-"));
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

it("checks only the planned Skill targets before submitting a revision", async () => {
  let pending = true;
  const revisions = sources();
  const result = {
    action: "apply" as const,
    changes: [
      {
        name: "Workflow",
        description: "Reusable workflow",
        normalizedKey: "workflow.test",
        sourceRefs: revisions.slice(0, 3).map((source) => source.ref),
        target: { type: "create" as const },
      },
    ],
  };
  const plan = vi.fn(async () => result);
  const submit = vi.fn(async () => undefined);
  const assertAvailable = vi.fn(async () => {
    if (pending) throw new Error("memory_revision_pending");
  });
  const module = await createSkillMemoryModule({
    pragmaHome: await temporaryRoot(),
    sourceReader: { listEligibleSources: async () => revisions },
    targetReader: { listTargets: async () => [] },
    planner: { plan },
    learningSink: { assertAvailable, submit },
    now: () => now,
  });
  try {
    await schedule(module, revisions);
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
    expect(assertAvailable).toHaveBeenCalledWith(expect.objectContaining({ plan: result }));
    expect(submit).not.toHaveBeenCalled();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "needs_attention",
      attempts: 1,
      lastErrorCode: "memory_revision_pending",
    });
    pending = false;
    await module.store.wakeNeedsAttention(now, "revision-settled");
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "pending", attempts: 1 });
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledOnce();
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "completed" });
  } finally {
    module.close();
  }
});

it("reopens historical nonretryable revision waits without resetting or exceeding the attempt budget", async () => {
  const pragmaHome = await temporaryRoot();
  let store = await createSkillLearningStore({ pragmaHome });
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
      store = await createSkillLearningStore({ pragmaHome });
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

it("does not submit a Skill plan after its job was interrupted during planning", async () => {
  const sourceRevisions = sources();
  const submit = vi.fn(async () => undefined);
  let interrupt = async () => undefined;
  const module = await createModule(sourceRevisions, {
    plan: async () => {
      await interrupt();
      return {
        action: "apply",
        changes: [
          {
            name: "Workflow",
            description: "Reusable workflow",
            normalizedKey: "workflow.example",
            sourceRefs: sourceRevisions.slice(0, 3).map((source) => source.ref),
            target: { type: "create" },
          },
        ],
      };
    },
    submit,
  });
  interrupt = async () => {
    const [job] = await module.store.listJobs();
    await module.interruptExtractionJob({ id: job!.id, expectedRevision: job!.revision, now });
  };
  try {
    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();
    expect(submit).not.toHaveBeenCalled();
  } finally {
    module.close();
  }
});

it("extracts a Skill from one successful complete workflow even with a low Episode score", async () => {
  const source = {
    ...episode("single-workflow", "one-conversation", "succeeded"),
    valueScore: 0.4,
  };
  const submit = vi.fn(async () => undefined);
  const plan = vi.fn(async () => ({
    action: "apply" as const,
    changes: [
      {
        name: "Verified workflow",
        description: "Inputs, complete steps and verification.",
        normalizedKey: "verified.workflow",
        sourceRefs: [source.ref],
        target: { type: "create" as const },
      },
    ],
  }));
  const module = await createModule([source], { plan, submit });
  try {
    await schedule(module, [source]);
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "retained",
    });
  } finally {
    module.close();
  }
});

it("does not treat recovery text in a failed task as proof of a successful workflow", async () => {
  const source = {
    ...episode("failed-recovery", "one-conversation", "failed"),
    hasSuccessfulRecovery: true,
  };
  const plan = vi.fn(async () => ({ action: "skip" as const }));
  const module = await createModule([source], { plan });
  try {
    await schedule(module, [source]);
    await module.runBackgroundOnce?.();
    expect(plan).not.toHaveBeenCalled();
  } finally {
    module.close();
  }
});

it("keeps a relevant old workflow beyond the first 100 source records", async () => {
  const sourceRevisions = Array.from({ length: 150 }, (_, index) =>
    episode(`episode-${index}`, `conversation-${index}`, index === 149 ? "succeeded" : "failed"),
  );
  const old = sourceRevisions[149]!;
  const submit = vi.fn(async () => undefined);
  const plan = vi.fn(async () => ({
    action: "apply" as const,
    changes: [
      {
        name: "Old verified workflow",
        description: "A reusable validated method.",
        normalizedKey: "old.workflow",
        sourceRefs: [old.ref],
        target: { type: "create" as const },
      },
    ],
  }));
  const module = await createModule(sourceRevisions, { plan, submit });
  try {
    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({ sources: expect.arrayContaining([old]) }),
    );
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    module.close();
  }
});

it("coalesces Episode notifications and defers Skill planning until the six-hour idle deadline", async () => {
  const root = await temporaryRoot();
  let clock = now;
  let available: readonly SkillSourceSnapshot[] = [episode("first", "conversation-a", "succeeded")];
  const plan = vi.fn(async () => ({
    action: "skip" as const,
    disposition: "accumulate" as const,
    reason: "Workflow details are incomplete.",
  }));
  const module = await createSkillMemoryModule({
    pragmaHome: root,
    now: () => clock,
    sourceReader: { listEligibleSources: async () => available },
    targetReader: { listTargets: async () => [] },
    planner: { plan },
    learningSink: { submit: vi.fn() },
  });
  try {
    await module.scheduleRoot(ref("pragma.expert", "expert-a"));
    clock = new Date(now.getTime() + 60_000);
    available = [...available, episode("second", "conversation-b", "succeeded")];
    await module.scheduleRoot(ref("pragma.expert", "expert-a"));
    expect(await module.store.listJobs()).toHaveLength(1);
    await module.runBackgroundOnce?.();
    expect(plan).not.toHaveBeenCalled();
    clock = new Date(clock.getTime() + 6 * 60 * 60_000);
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
    expect(module.store.getDecision?.((await module.store.listJobs())[0]!)).toMatchObject({
      outcome: "accumulate",
    });
  } finally {
    module.close();
  }
});

it("waits for a related pending Skill, reuses the waiting plan and resumes after settlement", async () => {
  const source = episode("verified-workflow", "one-conversation", "succeeded");
  const target = {
    bindingId: "11111111-1111-4111-8111-111111111111",
    capabilityId: "1h2j3k4m5n6p7q8r",
    name: "Existing workflow",
    description: "Verified workflow",
    normalizedKeys: ["workflow.pending"],
    pending: true,
    baseRevision: 0,
    contentHash: "a".repeat(64),
  };
  const plan = vi.fn(async () =>
    target.pending
      ? {
          action: "skip" as const,
          disposition: "accumulate" as const,
          reason: "Wait for the related workflow review.",
          waitForTarget: target.capabilityId,
        }
      : {
          action: "apply" as const,
          changes: [
            {
              name: target.name,
              description: "Improve result verification.",
              normalizedKey: "workflow.pending",
              sourceRefs: [source.ref],
              target: {
                type: "revise" as const,
                capabilityId: target.capabilityId,
                baseRevision: target.baseRevision,
                contentHash: target.contentHash,
              },
            },
          ],
        },
  );
  const submit = vi.fn(async () => undefined);
  const module = await createModule([source], { plan, submit, targets: [target] });
  try {
    await schedule(module, [source]);
    await module.runBackgroundOnce?.();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "needs_attention",
      lastErrorCode: "memory_revision_pending",
      attempts: 1,
    });
    await module.store.wakeNeedsAttention(now, "revision-settled");
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    target.pending = false;
    target.baseRevision = 1;
    await module.store.wakeNeedsAttention(now, "revision-settled");
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    module.close();
  }
});

it("keeps terminal notifications inside the Skill idle debounce", async () => {
  let clock = now;
  const available = [episode("complete", "conversation", "succeeded")];
  const plan = vi.fn(async () => ({ action: "skip" as const }));
  const module = await createSkillMemoryModule({
    pragmaHome: await temporaryRoot(),
    now: () => clock,
    sourceReader: { listEligibleSources: async () => available },
    targetReader: { listTargets: async () => [] },
    planner: { plan },
    learningSink: { submit: vi.fn() },
  });
  try {
    await module.scheduleRoot(ref("pragma.expert", "expert-a"));
    await module.consume([
      {
        topic: "execution.execution.terminal",
        messageId: "terminal",
        attribution: { rootRef: ref("pragma.expert", "expert-a") },
      } as unknown as import("@pragma/shared").MemoryEvidenceEnvelope,
    ]);
    await module.runBackgroundOnce?.();
    await module.runBackgroundOnce?.();
    expect(plan).not.toHaveBeenCalled();
    expect(await module.store.listJobs()).toHaveLength(1);
    clock = new Date(now.getTime() + 6 * 60 * 60_000);
    await module.runBackgroundOnce?.();
    expect(plan).toHaveBeenCalledOnce();
  } finally {
    module.close();
  }
});

it("settles repeated Skill target changes before submitting only the first qualifying revision", async () => {
  const available = [episode("complete", "conversation", "succeeded")];
  const target = {
    bindingId: "11111111-1111-4111-8111-111111111111",
    capabilityId: "1h2j3k4m5n6p7q8r",
    name: "Workflow",
    description: "Existing workflow",
    normalizedKeys: ["workflow.one", "workflow.two"],
    baseRevision: 1,
    contentHash: "a".repeat(64),
  };
  const submit = vi.fn<SkillLearningSink["submit"]>(async () => undefined);
  const module = await createModule(available, {
    targets: [target],
    submit,
    plan: async () => ({
      action: "apply",
      changes: target.normalizedKeys.map((normalizedKey) => ({
        name: "Workflow",
        description: "Improve validation",
        normalizedKey,
        sourceRefs: available.map((source) => source.ref),
        target: {
          type: "revise",
          capabilityId: target.capabilityId,
          baseRevision: 1,
          contentHash: target.contentHash,
        },
      })),
    }),
  });
  try {
    await schedule(module, available);
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledOnce();
    const submitted = submit.mock.calls[0]![0];
    expect(submitted.plan.changes).toHaveLength(1);
    const job = (await module.store.listJobs())[0]!;
    expect(job).toMatchObject({ status: "completed", completion: "retained" });
    expect(await module.store.listFailureAttempts(job.id)).toEqual([
      expect.objectContaining({
        diagnostic: expect.objectContaining({
          code: "skill_learning_plan_rejected",
          message: expect.stringContaining("same existing Skill"),
        }),
      }),
    ]);
  } finally {
    module.close();
  }
});

it("uses a new submission identity for a later Skill target version with the same supporting evidence", async () => {
  const available = [episode("complete", "conversation", "succeeded")];
  const target = {
    bindingId: "11111111-1111-4111-8111-111111111111",
    capabilityId: "1h2j3k4m5n6p7q8r",
    name: "Workflow",
    description: "Existing workflow",
    normalizedKeys: ["workflow.one"],
    baseRevision: 1,
    contentHash: "a".repeat(64),
  };
  const submit = vi.fn<SkillLearningSink["submit"]>(async () => undefined);
  const module = await createModule(available, {
    targets: [target],
    submit,
    plan: async () => ({
      action: "apply",
      changes: [
        {
          name: "Workflow",
          description: "Improve validation",
          normalizedKey: "workflow.one",
          sourceRefs: available.map((source) => source.ref),
          target: {
            type: "revise",
            capabilityId: target.capabilityId,
            baseRevision: target.baseRevision,
            contentHash: target.contentHash,
          },
        },
      ],
    }),
  });
  try {
    await schedule(module, available);
    await module.runBackgroundOnce?.();
    await module.store.pruneCompletedJobs({
      updatedAt: "2026-08-06T00:00:00.000Z",
      tieBreaker: "skill:z",
    });
    target.baseRevision = 2;
    target.contentHash = "b".repeat(64);
    await schedule(module, available);
    await module.runBackgroundOnce?.();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![0].sourceDigest).not.toBe(submit.mock.calls[0]![0].sourceDigest);
  } finally {
    module.close();
  }
});

it("reassesses sources completed under the old Skill learning policy", async () => {
  const available = [episode("complete", "conversation", "succeeded")];
  const plan = vi.fn(async () => ({ action: "skip" as const }));
  const module = await createModule(available, { plan });
  try {
    const rootRef = ref("pragma.expert", "expert-a");
    await module.store.schedule({ rootRef, sourceDigest: digestSources(available, ""), now });
    const old = (await module.store.claimDueJob(now))!;
    await module.store.complete(old, "rejected", now);
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

it.each([
  "oversized",
  "legacy",
  "legacy-text",
  "legacy-interrupted",
  "mixed",
  "truncated",
  "runtime",
  "exhausted",
] as const)(
  "recovers only proven oversized-description failures within budget after restart: %s",
  async (scenario) => {
    const pragmaHome = await temporaryRoot();
    let store = await createSkillLearningStore({ pragmaHome });
    const issue = { code: "too_big", maximum: 500, path: ["changes", 0, "description"] };
    try {
      await store.schedule({
        rootRef: ref("pragma.expert", "expert-summary"),
        sourceDigest: "b".repeat(64),
        now,
      });
      const job = (await store.claimDueJob(now))!;
      await store.fail({
        job,
        retry: "transient",
        now,
        diagnostic: {
          schemaVersion: "pragma.memory-extraction-failure/v1",
          code: scenario === "runtime" ? "runtime_failed" : "skill_extraction_validation_failed",
          message:
            scenario === "truncated"
              ? "[{"
              : JSON.stringify(
                  scenario === "mixed"
                    ? [issue, { code: "invalid_type", path: ["changes", 0, "sourceRefs"] }]
                    : [issue],
                ),
          phase: "validation",
          failedAt: now.toISOString(),
          retryable: false,
        },
      });
      store.close();
      if (scenario === "exhausted" || scenario.startsWith("legacy")) {
        const path = join(
          new PragmaPaths({ pragmaHome }).memoryModuleDataRoot("pragma.memory.skill-learning"),
          "skill-learning.sqlite",
        );
        const db = new DatabaseSync(path);
        if (scenario === "exhausted")
          db.prepare("UPDATE jobs SET job_json=json_set(job_json, '$.attempts', 4)").run();
        else {
          db.prepare("DELETE FROM job_failure_attempts").run();
          if (scenario === "legacy-text")
            db.prepare("UPDATE jobs SET job_json=json_remove(job_json, '$.lastFailure')").run();
          if (scenario === "legacy-interrupted")
            db.exec(`CREATE TRIGGER interrupt_summary_recovery BEFORE UPDATE ON jobs
              WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT, 'simulated recovery interruption'); END;`);
        }
        db.close();
      }
      store = await createSkillLearningStore({ pragmaHome });
      if (scenario === "legacy-interrupted") {
        await expect(store.claimDueJob(now)).rejects.toThrow("simulated recovery interruption");
        expect((await store.listJobs())[0]).toMatchObject({
          status: "needs_attention",
          attempts: 1,
        });
        expect(await store.listFailureAttempts(job.id)).toHaveLength(0);
        store.close();
        const path = join(
          new PragmaPaths({ pragmaHome }).memoryModuleDataRoot("pragma.memory.skill-learning"),
          "skill-learning.sqlite",
        );
        const db = new DatabaseSync(path);
        db.exec("DROP TRIGGER interrupt_summary_recovery");
        db.close();
        store = await createSkillLearningStore({ pragmaHome });
      }
      const recovered = await store.claimDueJob(now);
      if (scenario === "oversized" || scenario.startsWith("legacy")) {
        expect(recovered).toMatchObject({ status: "running", attempts: 2 });
        expect(await store.listFailureAttempts(recovered!.id)).toHaveLength(1);
        await store.complete(recovered!, "retained", now);
        expect((await store.listJobs())[0]).toMatchObject({
          status: "completed",
          completion: "retained",
        });
        expect(await store.claimDueJob(now)).toBeUndefined();
      } else {
        expect(recovered).toBeUndefined();
        expect((await store.listJobs())[0]?.status).toBe("needs_attention");
      }
    } finally {
      store.close();
    }
  },
);

it("preserves the model budget while observing an owned Revision execution", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-skill-observation-"));
  roots.push(pragmaHome);
  const store = await createSkillLearningStore({ pragmaHome });
  const rootRef = { type: "pragma.expert" as const, id: "expert-observe" };
  const time = new Date("2026-10-26T00:00:00.000Z");
  try {
    await store.schedule({ rootRef, sourceDigest: "a".repeat(64), now: time });
    let clock = new Date(time.getTime() + 24 * 60 * 60_000);
    let claim = (await store.claimDueJob(clock))!;
    expect(claim.attempts).toBe(1);
    await store.deferObservation(claim, clock);
    for (let step = 0; step < 5; step++) {
      clock = new Date(clock.getTime() + 5001);
      claim = (await store.claimDueJob(clock, new Set([claim.id])))!;
      expect(claim.attempts).toBe(1);
      await store.deferObservation(claim, clock);
    }
    expect((await store.listJobs())[0]!.attempts).toBe(1);
    clock = new Date(clock.getTime() + 5001);
    claim = (await store.claimDueJob(clock, new Set([claim.id])))!;
    clock = new Date(clock.getTime() + 6 * 60_000);
    expect(await store.claimDueJob(clock)).toBeUndefined();
    expect((await store.listJobs())[0]!.lastErrorCode).toBe(
      "memory_extraction_execution_unconfirmed",
    );
    await store.resumeObservation(claim.id, clock);
    const resumed = (await store.claimDueJob(clock, new Set([claim.id])))!;
    expect(resumed.attempts).toBe(1);
  } finally {
    store.close();
  }
});

it("runs new Skill work through the direct Revision port without a plan handoff", async () => {
  let clock = now;
  const execute = vi.fn(
    async (
      input: Parameters<
        import("../src/learning/revision-execution.ts").MemoryRevisionExecutor["execute"]
      >[0],
    ) => {
      await input.assertCurrent();
      return {
        submitted: false,
        decision: {
          outcome: "accumulate" as const,
          reason: "No supported workflow delta.",
          targets: [],
        },
      };
    },
  );
  const plan = vi.fn(async () => {
    throw new Error("New work must not use a Planner");
  });
  const submit = vi.fn();
  const module = await createSkillMemoryModule({
    pragmaHome: await temporaryRoot(),
    now: () => clock,
    sourceReader: { listEligibleSources: async () => sources() },
    targetReader: { listTargets: async () => [] },
    executor: { execute },
    planner: { plan },
    learningSink: { submit },
  });
  try {
    await module.scheduleRoot({ type: "pragma.expert", id: "expert-a" });
    clock = new Date(now.getTime() + 24 * 60 * 60_000);
    await module.runBackgroundOnce?.();
    expect(execute).toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect((await module.store.listJobs())[0]).toMatchObject({
      status: "completed",
      completion: "rejected",
    });
  } finally {
    module.close();
  }
});
