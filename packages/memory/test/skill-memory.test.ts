import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import type { MemorySubjectRef, SkillLearningJob, SkillSourceSnapshot } from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSkillMemoryModule, type SkillLearningSink } from "../src/index.ts";
import { createSkillLearningStore } from "../src/skill/store.ts";

const roots: string[] = [];
const now = new Date("2026-08-05T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Skill learning revision planning", () => {
  it("completes insufficient evidence without invoking the Agent", async () => {
    const plan = vi.fn(async () => ({ action: "skip" as const }));
    const module = await createModule(sources().slice(0, 2), { plan });
    await schedule(module, sources().slice(0, 2));
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

  it("retries a plan with an invented source", async () => {
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
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "pending" });
    module.close();
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
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "pending" });
    module.close();
  });

  it("rejects duplicate Skill identities in one plan", async () => {
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
    expect(submit).not.toHaveBeenCalled();
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "pending" });
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
    expect((await module.store.listJobs())[0]).toMatchObject({ status: "pending" });
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

describe("Skill learning store v3 migration", () => {
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
    ).toBe(4);
    migrated.close();
    await expect(stat(`${databasePath}.v1.backup`)).resolves.toBeDefined();
  });

  it("opens current v3 storage without rewriting jobs", async () => {
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
    database.prepare("UPDATE schema_meta SET version=5").run();
    database.close();

    await expect(createSkillLearningStore({ pragmaHome: root })).rejects.toThrow(
      "Unsupported pragma.memory-skill-learning-store version.",
    );
  });
});

async function createModule(
  sourceRevisions: readonly SkillSourceSnapshot[],
  overrides: {
    readonly plan: NonNullable<Parameters<typeof createSkillMemoryModule>[0]["planner"]>["plan"];
    readonly submit?: SkillLearningSink["submit"];
    readonly targets?: readonly import("@pragma/shared").ExistingMemorySkillTarget[];
  },
) {
  return await createSkillMemoryModule({
    pragmaHome: await temporaryRoot(),
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

function digestSources(sourceRevisions: readonly SkillSourceSnapshot[]): string {
  const keys = sourceRevisions
    .map((source) => `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`)
    .toSorted();
  return createHash("sha256")
    .update(["skill-sources", ...keys].join("\0"))
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
  ) as { readonly jobs: readonly SkillLearningJob[] };
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
  database.close();
  return databasePath;
}

function ref(type: string, id: string): MemorySubjectRef {
  return { type, id };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-skill-learning-"));
  roots.push(root);
  return root;
}
