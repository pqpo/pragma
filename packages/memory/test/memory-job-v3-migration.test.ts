import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import { createEpisodicMemoryModule, createSemanticMemoryModule } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Memory extraction job v3 migration", () => {
  it.each([
    {
      moduleId: "pragma.memory.episodic",
      file: "episodes.sqlite",
      open: createEpisodicMemoryModule,
    },
    {
      moduleId: "pragma.memory.semantic",
      file: "facts.sqlite",
      open: createSemanticMemoryModule,
    },
  ] as const)(
    "upgrades $moduleId data v3 with a backed-up hot/archive index",
    async ({ moduleId, file, open }) => {
      const root = await temporaryRoot();
      const initial = await open({ pragmaHome: root });
      initial.close();
      const dataPath = join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot(moduleId),
        file,
      );
      const historical = new DatabaseSync(dataPath);
      historical.exec(`
      DROP TABLE memory_index;
      DROP TABLE revision_prune_audit;
      ${moduleId === "pragma.memory.semantic" ? "DROP TABLE projection_notifications;" : ""}
      PRAGMA user_version = 3;
    `);
      historical.close();

      const migratedModule = await open({ pragmaHome: root });
      const migrated = new DatabaseSync(dataPath);
      expect(
        (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(moduleId === "pragma.memory.semantic" ? 5 : 4);
      expect(
        migrated
          .prepare(
            "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='memory_index'",
          )
          .get(),
      ).toEqual({ found: 1 });
      migrated.close();
      const backup = new DatabaseSync(`${dataPath}.v3.backup`);
      expect(
        (backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(3);
      backup.close();
      if (moduleId === "pragma.memory.semantic") {
        const v4Backup = new DatabaseSync(`${dataPath}.v4.backup`);
        expect(
          (v4Backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        ).toBe(4);
        v4Backup.close();
      }
      migratedModule.close();
    },
  );

  it.each([
    {
      moduleId: "pragma.memory.episodic",
      schemaVersion: "pragma.memory-extraction-job/v3",
      currentSchemaVersion: "pragma.memory-extraction-job/v4",
      open: createEpisodicMemoryModule,
    },
    {
      moduleId: "pragma.memory.semantic",
      schemaVersion: "pragma.memory-semantic-job/v3",
      currentSchemaVersion: "pragma.memory-semantic-job/v4",
      open: createSemanticMemoryModule,
    },
  ] as const)(
    "upgrades adjacent $moduleId v3 diagnostics storage without changing job semantics",
    async ({ moduleId, schemaVersion, currentSchemaVersion, open }) => {
      const root = await temporaryRoot();
      const statePath = join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(moduleId),
        "jobs.sqlite",
      );
      await mkdir(join(statePath, ".."), { recursive: true });
      const database = new DatabaseSync(statePath);
      database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL UNIQUE,
          terminal_message_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          retry_at TEXT,
          lease_until TEXT,
          job_json TEXT NOT NULL
        );
        PRAGMA user_version = 3;
      `);
      const job = {
        schemaVersion,
        id: `${moduleId}-v3-job`,
        revision: 4,
        conversationRef: { type: "pragma.execution", id: "v3-execution" },
        sourceExecutionIds: ["v3-execution"],
        sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
        inputWatermark: "v3-terminal",
        executionId: "v3-execution",
        terminalMessageId: "v3-terminal",
        status: "needs_attention",
        attempts: 3,
        totalAttempts: 3,
        lastErrorCode: "skill_extraction_failed",
        failureClass: "transient-exhausted",
        attentionSince: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      database
        .prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, NULL, NULL, ?)")
        .run(job.id, job.executionId, job.terminalMessageId, job.status, JSON.stringify(job));
      database.close();

      const module = await open({ pragmaHome: root });
      expect(await module.store.listExtractionJobs()).toEqual([
        expect.objectContaining({
          schemaVersion: currentSchemaVersion,
          id: job.id,
          revision: job.revision,
          lastErrorCode: job.lastErrorCode,
        }),
      ]);
      const migrated = new DatabaseSync(statePath);
      expect(
        migrated
          .prepare(
            "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='job_failure_attempts'",
          )
          .get(),
      ).toEqual({ found: 1 });
      expect(
        (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(4);
      migrated.close();
      await expect(readFile(`${statePath}.v3.backup`)).resolves.toBeDefined();
      module.close();
    },
  );

  it.each([
    {
      moduleId: "pragma.memory.episodic",
      count: 6,
      fixtureKey: "episodic",
      open: createEpisodicMemoryModule,
    },
    {
      moduleId: "pragma.memory.semantic",
      count: 9,
      fixtureKey: "semantic",
      open: createSemanticMemoryModule,
    },
  ] as const)(
    "repairs $count historical malformed $moduleId attention jobs without replaying executions",
    async ({ moduleId, count, fixtureKey, open }) => {
      const root = await temporaryRoot();
      const statePath = join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(moduleId),
        "jobs.sqlite",
      );
      await mkdir(join(statePath, ".."), { recursive: true });
      const database = new DatabaseSync(statePath);
      database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL UNIQUE,
          terminal_message_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          retry_at TEXT,
          lease_until TEXT,
          job_json TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      const insert = database.prepare(
        `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, 'needs_attention', NULL, NULL, ?)`,
      );
      const fixture = JSON.parse(
        await readFile(
          new URL("./fixtures/memory-extraction-malformed-attention-v1.json", import.meta.url),
          "utf8",
        ),
      ) as Record<
        "episodic" | "semantic",
        readonly {
          readonly id: string;
          readonly executionId: string;
          readonly terminalMessageId: string;
          readonly status: "needs_attention";
        }[]
      >;
      const fixtureJobs = fixture[fixtureKey];
      expect(fixtureJobs).toHaveLength(count);
      for (const job of fixtureJobs) {
        insert.run(job.id, job.executionId, job.terminalMessageId, JSON.stringify(job));
      }
      database.close();

      const module = await open({ pragmaHome: root });
      const migratedJobs = await module.store.listExtractionJobs();
      expect(migratedJobs).toHaveLength(count);
      expect(
        migratedJobs.every(
          (job) =>
            job.status === "pending" &&
            job.attempts === 0 &&
            job.lastErrorCode === undefined &&
            job.conversationRef.type === "pragma.execution",
        ),
      ).toBe(true);
      const migrated = new DatabaseSync(statePath);
      expect(
        (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(4);
      migrated.close();
      const backup = new DatabaseSync(`${statePath}.v1.backup`);
      expect(
        (backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(1);
      backup.close();
      module.close();
    },
  );

  it.each([
    {
      moduleId: "pragma.memory.episodic",
      schemaVersion: "pragma.memory-extraction-job/v2",
      open: createEpisodicMemoryModule,
    },
    {
      moduleId: "pragma.memory.semantic",
      schemaVersion: "pragma.memory-semantic-job/v2",
      open: createSemanticMemoryModule,
    },
  ] as const)(
    "upgrades an adjacent $moduleId v2 job",
    async ({ moduleId, schemaVersion, open }) => {
      const root = await temporaryRoot();
      const statePath = join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(moduleId),
        "jobs.sqlite",
      );
      await mkdir(join(statePath, ".."), { recursive: true });
      const database = new DatabaseSync(statePath);
      database.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        terminal_message_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        retry_at TEXT,
        lease_until TEXT,
        job_json TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `);
      const job = {
        schemaVersion,
        id: "v2-job",
        revision: 1,
        executionId: "v2-execution",
        terminalMessageId: "v2-terminal",
        status: "pending",
        attempts: 0,
        totalAttempts: 0,
        retryAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      };
      database
        .prepare(
          `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          job.id,
          job.executionId,
          job.terminalMessageId,
          job.status,
          job.retryAt,
          JSON.stringify(job),
        );
      database.close();

      const module = await open({ pragmaHome: root });
      await expect(module.store.listExtractionJobs()).resolves.toEqual([
        expect.objectContaining({
          id: job.id,
          revision: 2,
          conversationRef: { type: "pragma.execution", id: job.executionId },
          sourceExecutionIds: [job.executionId],
        }),
      ]);
      const backup = new DatabaseSync(`${statePath}.v2.backup`);
      expect(
        (backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      ).toBe(2);
      backup.close();
      module.close();
    },
  );

  it("upgrades semantic v2 applied jobs to input-watermark identities", async () => {
    const root = await temporaryRoot();
    const dataPath = join(
      new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.semantic"),
      "facts.sqlite",
    );
    await mkdir(join(dataPath, ".."), { recursive: true });
    const database = new DatabaseSync(dataPath);
    database.exec(`
      CREATE TABLE applied_jobs (
        job_id TEXT PRIMARY KEY,
        terminal_message_id TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO applied_jobs(job_id, terminal_message_id, applied_at)
        VALUES ('semantic-conversation', 'terminal-v2', '2026-08-01T00:00:00.000Z');
      PRAGMA user_version = 2;
    `);
    database.close();

    const module = await createSemanticMemoryModule({ pragmaHome: root });
    const migrated = new DatabaseSync(dataPath);
    expect(
      migrated
        .prepare("SELECT input_watermark AS inputWatermark FROM applied_jobs WHERE job_id = ?")
        .get("semantic-conversation"),
    ).toEqual({ inputWatermark: "terminal-v2" });
    migrated.close();
    const backup = new DatabaseSync(`${dataPath}.v2.backup`);
    expect(
      (backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(2);
    backup.close();
    module.close();
  });

  it("indexes migrated episodic Evidence ownership by source Execution", async () => {
    const root = await temporaryRoot();
    const dataPath = join(
      new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.episodic"),
      "episodes.sqlite",
    );
    await mkdir(join(dataPath, ".."), { recursive: true });
    const database = new DatabaseSync(dataPath);
    database.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE TABLE episode_revisions (
        episode_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (episode_id, revision)
      );
      PRAGMA user_version = 2;
    `);
    const record = {
      schemaVersion: "pragma.memory-episodic/v2",
      id: "episode-v2",
      revision: 1,
      executionId: "execution-v2",
      terminalMessageId: "terminal-v2",
      rootRefs: [{ type: "pragma.expert", id: "expert-v2" }],
      producerRefs: [{ type: "pragma.expert", id: "expert-v2" }],
      language: "en",
      goal: {
        text: "Preserve migrated Evidence ownership.",
        evidenceRefs: ["evidence-v2"],
      },
      summary: {
        text: "A migrated historical episode.",
        evidenceRefs: ["evidence-v2"],
      },
      attempts: [],
      failuresAndRecoveries: [],
      outcome: {
        status: "succeeded",
        summary: "Migration succeeded.",
        evidenceRefs: ["evidence-v2"],
      },
      artifactRefs: [],
      evidenceRefs: ["evidence-v2"],
      visibility: { mode: "host-private" },
      sensitivity: "confidential",
      bindings: [
        {
          consumerRef: { type: "pragma.expert", id: "expert-v2" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
      valueScore: 0.8,
      status: "active",
      extractor: {
        curatorRef: "pragma.memory-curator",
        promptVersion: "pragma.memory-curator/v1",
        profileRevision: 0,
        runtimeId: "test-runtime",
        providerId: "test-provider",
        modelId: "test-model",
        extractedAt: "2026-08-01T00:00:00.000Z",
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    database
      .prepare(
        `INSERT INTO episodes(id, execution_id, revision, status, updated_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.executionId,
        record.revision,
        record.status,
        record.updatedAt,
        JSON.stringify(record),
      );
    database
      .prepare("INSERT INTO episode_revisions(episode_id, revision, record_json) VALUES (?, ?, ?)")
      .run(record.id, record.revision, JSON.stringify(record));
    database.close();

    const module = await createEpisodicMemoryModule({ pragmaHome: root });
    const migrated = new DatabaseSync(dataPath);
    expect(
      migrated
        .prepare(
          "SELECT episode_id AS episodeId, execution_id AS executionId FROM episode_source_executions",
        )
        .all(),
    ).toEqual([{ episodeId: record.id, executionId: record.executionId }]);
    migrated.close();
    module.close();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-job-migration-"));
  roots.push(root);
  return root;
}
