import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import type {
  MemorySubjectRef,
  SkillExtractionCandidate,
  SkillLearningJob,
  SkillSourceSnapshot,
} from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSkillMemoryModule,
  type SkillLearningSink,
  type SkillMemoryExtractor,
} from "../src/index.ts";
import { createSkillLearningStore } from "../src/skill/store.ts";

const roots: string[] = [];
const now = new Date("2026-08-05T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Skill learning extraction", () => {
  it("completes insufficient overall evidence as a normal rejected result", async () => {
    const sourceRevisions = sources().slice(0, 2);
    const extract = vi.fn<SkillMemoryExtractor["extract"]>(async () =>
      extractionResult([candidate("unused", validRefs())]),
    );
    const module = await createModule(sourceRevisions, { extract });

    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();

    expect(extract).not.toHaveBeenCalled();
    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "rejected" }),
    ]);
    expect(await module.store.inspect()).toMatchObject({ needsAttention: 0, completed: 1 });
    module.close();
  });

  it("extracts only from producer Experts whose own evidence meets the threshold", async () => {
    const sourceRevisions = [
      episode("expert-a-one", "conversation-a", "succeeded", "expert-a"),
      episode("expert-a-two", "conversation-a", "succeeded", "expert-a"),
      episode("expert-a-three", "conversation-a", "succeeded", "expert-a"),
      episode("expert-b-one", "conversation-b", "succeeded", "expert-b"),
      episode("expert-b-two", "conversation-b", "succeeded", "expert-b"),
      episode("expert-b-three", "conversation-c", "failed", "expert-b"),
    ];
    const extract = vi.fn<SkillMemoryExtractor["extract"]>(async (input) => {
      expect(
        input.sources.every((source) => source.producerRefs.some((ref) => ref.id === "expert-b")),
      ).toBe(true);
      return {
        output: { retain: false, reason: "no-reusable-skill" },
        provenance: provenance(),
      };
    });
    const module = await createModule(sourceRevisions, { extract });

    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();

    expect(extract).toHaveBeenCalledOnce();
    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "rejected" }),
    ]);
    module.close();
  });

  it("filters a candidate below the source threshold and completes without user attention", async () => {
    const sourceRevisions = sources();
    const submit = vi.fn(async () => undefined);
    const module = await createModule(sourceRevisions, {
      extract: vi.fn(async () => extractionResult([candidate("invalid", invalidRefs())])),
      submit,
    });

    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();

    expect(submit).not.toHaveBeenCalled();
    const [job] = await module.store.listJobs();
    expect(job).toMatchObject({ status: "completed", completion: "rejected" });
    expect(job).not.toHaveProperty("lastErrorCode");
    expect(job).not.toHaveProperty("failureClass");
    expect(await module.store.inspect()).toMatchObject({ needsAttention: 0, completed: 1 });
    module.close();
  });

  it("submits valid candidates while quietly discarding threshold failures", async () => {
    const sourceRevisions = sources();
    const valid = candidate("valid", validRefs());
    const submit = vi.fn(async () => undefined);
    const module = await createModule(sourceRevisions, {
      extract: vi.fn(async () => extractionResult([candidate("invalid", invalidRefs()), valid])),
      submit,
    });

    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();

    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: [valid], sources: sourceRevisions }),
    );
    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "retained" }),
    ]);
    module.close();
  });

  it("filters stale targets and duplicate keys without discarding valid siblings", async () => {
    const sourceRevisions = sources();
    const valid = candidate("valid", validRefs());
    const duplicate = {
      ...candidate("valid", validRefs()),
      content: { ...valid.content, package: { ...valid.content.package, name: "Duplicate" } },
    };
    const staleTarget = {
      ...candidate("stale-target", validRefs()),
      route: {
        type: "revise" as const,
        bindingId: "00000000-0000-4000-8000-000000000099",
      },
    };
    const submit = vi.fn(async () => undefined);
    const module = await createModule(sourceRevisions, {
      extract: vi.fn(async () => extractionResult([staleTarget, valid, duplicate])),
      submit,
    });

    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ candidates: [valid] }));
    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "retained" }),
    ]);
    module.close();
  });

  it("records retain=false as rejected instead of retained", async () => {
    const sourceRevisions = sources();
    const module = await createModule(sourceRevisions, {
      extract: vi.fn(async () => ({
        output: { retain: false as const, reason: "no-reusable-skill" as const },
        provenance: provenance(),
      })),
    });

    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();

    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({ status: "completed", completion: "rejected" }),
    ]);
    module.close();
  });

  it("keeps genuine extractor configuration failures actionable", async () => {
    const sourceRevisions = sources();
    const module = await createModule(sourceRevisions, {
      extract: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });

    await schedule(module, sourceRevisions);
    await module.runBackgroundOnce?.();

    expect(await module.store.listJobs()).toEqual([
      expect.objectContaining({
        status: "needs_attention",
        failureClass: "configuration",
      }),
    ]);
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
    readonly extract: SkillMemoryExtractor["extract"];
    readonly submit?: SkillLearningSink["submit"];
  },
) {
  return await createSkillMemoryModule({
    pragmaHome: await temporaryRoot(),
    sourceReader: { listEligibleSources: async () => sourceRevisions },
    targetReader: { listTargets: async () => [] },
    extractor: { extract: overrides.extract },
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

function extractionResult(
  candidates: readonly SkillExtractionCandidate[],
): Awaited<ReturnType<SkillMemoryExtractor["extract"]>> {
  return { output: { retain: true, candidates: [...candidates] }, provenance: provenance() };
}

function provenance() {
  return {
    curatorRef: "pragma.memory.curator",
    promptVersion: "skill-curator/v1",
    profileRevision: 1,
    runtimeId: "runtime-a",
    providerId: "provider-a",
    modelId: "model-a",
    extractedAt: now.toISOString(),
  };
}

function candidate(
  normalizedKey: string,
  sourceRefs: SkillExtractionCandidate["sourceRefs"],
): SkillExtractionCandidate {
  const replay = (objective: string) => ({
    objective,
    requiredBehaviors: ["Apply the reusable workflow."],
    forbiddenBehaviors: [],
  });
  return {
    content: {
      normalizedKey: `workflow.${normalizedKey}`,
      applicability: ["A repeated workflow is required."],
      failureModes: ["The workflow is applied without enough evidence."],
      recoverySteps: ["Re-check the source evidence."],
      package: {
        name: `Workflow ${normalizedKey}`,
        description: "A reusable workflow learned from successful executions.",
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: workflow-${normalizedKey}\ndescription: Reusable workflow\n---\n`,
          },
        ],
      },
      replayCases: [replay("Replay one"), replay("Replay two"), replay("Replay three")],
      boundaryCase: {
        objective: "Recognize when the workflow does not apply.",
        requiredBehaviors: ["Decline to force the workflow."],
        forbiddenBehaviors: ["Apply the workflow anyway."],
      },
    },
    sourceRefs,
    route: { type: "create" },
  };
}

function validRefs(): SkillExtractionCandidate["sourceRefs"] {
  return sources()
    .slice(0, 3)
    .map((source) => source.ref);
}

function invalidRefs(): SkillExtractionCandidate["sourceRefs"] {
  const sourceRevisions = sources();
  return [sourceRevisions[0]!.ref, sourceRevisions[1]!.ref, sourceRevisions[3]!.ref];
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
