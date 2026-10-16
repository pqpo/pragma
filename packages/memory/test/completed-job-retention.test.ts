import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  pruneCompletedMemoryJobs,
  retainCompletedMemoryJobs,
  retainMemoryExtractionHistory,
} from "../src/pipeline/completed-job-retention.ts";
import { queryMemoryJobPage } from "../src/pipeline/memory-job-page.ts";
import { initializeExtractionFailureAttempts } from "../src/pipeline/extraction-failure-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function store(module: string, count: number, sameTime = false) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, status TEXT, job_json TEXT)");
  initializeExtractionFailureAttempts(database);
  const insert = database.prepare("INSERT INTO jobs VALUES (?, ?, ?)");
  for (let index = 0; index < count; index++) {
    const id = `job-${String(index).padStart(3, "0")}`;
    insert.run(
      id,
      "completed",
      JSON.stringify({
        id,
        updatedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, sameTime ? 0 : index)).toISOString(),
      }),
    );
  }
  insert.run(
    "pending",
    "pending",
    JSON.stringify({ id: "pending", updatedAt: "2010-01-01T00:00:00.000Z" }),
  );
  return {
    module,
    database,
    list: (input: Parameters<typeof queryMemoryJobPage>[1]) =>
      Promise.resolve(
        queryMemoryJobPage(
          database,
          input,
          (json) => JSON.parse(json) as { id: string; updatedAt: string },
        ),
      ),
    prune: (before: Parameters<typeof pruneCompletedMemoryJobs>[2]) =>
      Promise.resolve(pruneCompletedMemoryJobs(database, module, before)),
  };
}

function completedCount(database: DatabaseSync) {
  return (
    database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='completed'").get() as {
      count: number;
    }
  ).count;
}

describe("completed memory job retention", () => {
  it("counts a completed pair once and protects the completed half of unfinished work", async () => {
    const episodic = store("episodic", 60);
    const semantic = store("semantic", 60);
    const knowledge = store("knowledge", 0);
    const skill = store("skill", 0);
    episodic.database
      .prepare("INSERT INTO jobs VALUES (?,?,?)")
      .run(
        "half",
        "completed",
        JSON.stringify({ id: "half", updatedAt: "2000-01-01T00:00:00.000Z" }),
      );
    semantic.database
      .prepare("INSERT INTO jobs VALUES (?,?,?)")
      .run(
        "half",
        "pending",
        JSON.stringify({ id: "half", updatedAt: "2000-01-01T00:00:00.000Z" }),
      );
    const delivery = (entry: ReturnType<typeof store>) => ({
      listExtractionJobs: async () =>
        entry.database
          .prepare("SELECT status, job_json FROM jobs")
          .all()
          .map((row) => {
            const job = JSON.parse(row["job_json"] as string) as { id: string; updatedAt: string };
            return {
              ...job,
              status: row["status"],
              conversationRef: { type: "pragma.execution", id: job.id },
              inputWatermark: job.id,
            };
          }),
      pruneCompletedJobs: async (
        before: Parameters<typeof pruneCompletedMemoryJobs>[2],
        keep: readonly string[] = [],
      ) => pruneCompletedMemoryJobs(entry.database, entry.module, before, undefined, keep),
    });
    await retainMemoryExtractionHistory({
      episodicStore: delivery(episodic),
      semanticStore: delivery(semantic),
      knowledgeLearningStore: { listJobsPage: knowledge.list, pruneCompletedJobs: knowledge.prune },
      skillLearningStore: { listJobsPage: skill.list, pruneCompletedJobs: skill.prune },
    } as unknown as Parameters<typeof retainMemoryExtractionHistory>[0]);
    expect(completedCount(episodic.database)).toBe(51);
    expect(completedCount(semantic.database)).toBe(50);
    expect(episodic.database.prepare("SELECT id FROM jobs WHERE id='half'").get()).toBeDefined();
    expect(
      episodic.database.prepare("SELECT id FROM jobs WHERE id='job-009'").get(),
    ).toBeUndefined();
    expect(
      semantic.database.prepare("SELECT id FROM jobs WHERE id='job-009'").get(),
    ).toBeUndefined();
  });
  it("keeps 50 newest records across all four modules and preserves pending work", async () => {
    const stores = ["episodic", "semantic", "knowledge", "skill"].map((module) =>
      store(module, 30),
    );
    await retainCompletedMemoryJobs(stores);
    expect(stores.reduce((sum, entry) => sum + completedCount(entry.database), 0)).toBe(50);
    for (const entry of stores) {
      expect(entry.database.prepare("SELECT id FROM jobs WHERE id='pending'").get()).toBeDefined();
      expect(
        entry.database.prepare("SELECT id FROM jobs WHERE id='job-000'").get(),
      ).toBeUndefined();
      expect(entry.database.prepare("SELECT id FROM jobs WHERE id='job-029'").get()).toBeDefined();
    }
    await retainCompletedMemoryJobs(stores);
    expect(stores.reduce((sum, entry) => sum + completedCount(entry.database), 0)).toBe(50);
  });

  it("resolves equal timestamps deterministically across modules", async () => {
    const stores = [store("episodic", 40, true), store("semantic", 40, true)];
    await retainCompletedMemoryJobs(stores);
    expect(completedCount(stores[0]!.database)).toBe(10);
    expect(completedCount(stores[1]!.database)).toBe(40);
  });

  it("retains records of any age below the limit and bounds a single busy module", async () => {
    const small = store("knowledge", 10);
    await retainCompletedMemoryJobs([small]);
    expect(completedCount(small.database)).toBe(10);
    const busy = store("skill", 80);
    await retainCompletedMemoryJobs([busy]);
    expect(completedCount(busy.database)).toBe(50);
    expect(busy.database.prepare("SELECT id FROM jobs WHERE id='job-029'").get()).toBeUndefined();
    expect(busy.database.prepare("SELECT id FROM jobs WHERE id='job-030'").get()).toBeDefined();
  });

  it("rolls back failed cleanup and can safely replay it", async () => {
    const entry = store("episodic", 60);
    entry.database
      .prepare("INSERT INTO job_failure_attempts VALUES (?, ?, ?, ?)")
      .run("failure", "job-000", "2020-01-01T00:00:00.000Z", "{}");
    entry.database.exec(
      "CREATE TRIGGER reject_prune BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    await expect(retainCompletedMemoryJobs([entry])).rejects.toThrow("blocked");
    expect(completedCount(entry.database)).toBe(60);
    expect(entry.database.prepare("SELECT id FROM job_failure_attempts").all()).toHaveLength(1);
    entry.database.exec("DROP TRIGGER reject_prune");
    await retainCompletedMemoryJobs([entry]);
    expect(completedCount(entry.database)).toBe(50);
    expect(entry.database.prepare("SELECT id FROM job_failure_attempts").all()).toHaveLength(0);
  });

  it("preserves a job that becomes pending after the retention snapshot", async () => {
    const entry = store("episodic", 60);
    const prune = entry.prune;
    entry.prune = async (before) => {
      entry.database.prepare("UPDATE jobs SET status='pending' WHERE id='job-000'").run();
      return prune(before);
    };
    await retainCompletedMemoryJobs([entry]);
    expect(completedCount(entry.database)).toBe(50);
    expect(
      entry.database.prepare("SELECT status FROM jobs WHERE id='job-000'").get(),
    ).toMatchObject({ status: "pending" });
  });
});
