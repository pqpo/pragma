import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { queryMemoryJobPage } from "../src/pipeline/memory-job-page.ts";

let database: DatabaseSync | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("queryMemoryJobPage", () => {
  it("uses a stable cursor and returns only the requested page from SQLite", () => {
    database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, status TEXT, job_json TEXT)");
    const insert = database.prepare("INSERT INTO jobs(id, status, job_json) VALUES (?, ?, ?)");
    for (let index = 0; index < 12; index += 1) {
      const id = `job-${String(index).padStart(2, "0")}`;
      insert.run(
        id,
        "completed",
        JSON.stringify({
          id,
          updatedAt: new Date(Date.UTC(2026, 7, 5, 0, 0, index)).toISOString(),
        }),
      );
    }

    const first = queryMemoryJobPage(
      database,
      { statuses: ["completed"], limit: 10, sortKeyPrefix: "episodic" },
      (json) => JSON.parse(json) as { readonly id: string; readonly updatedAt: string },
    );
    expect(first.total).toBe(12);
    expect(first.jobs).toHaveLength(10);
    expect(first.jobs[0]?.id).toBe("job-11");
    expect(first.jobs[9]?.id).toBe("job-02");

    const second = queryMemoryJobPage(
      database,
      {
        statuses: ["completed"],
        limit: 10,
        sortKeyPrefix: "episodic",
        before: {
          updatedAt: first.jobs[9]!.updatedAt,
          tieBreaker: `episodic:${first.jobs[9]!.id}`,
        },
      },
      (json) => JSON.parse(json) as { readonly id: string; readonly updatedAt: string },
    );
    expect(second.total).toBe(12);
    expect(second.jobs.map((job) => job.id)).toEqual(["job-01", "job-00"]);

    const afterEnd = queryMemoryJobPage(
      database,
      {
        statuses: ["completed"],
        limit: 10,
        sortKeyPrefix: "episodic",
        before: {
          updatedAt: second.jobs[1]!.updatedAt,
          tieBreaker: `episodic:${second.jobs[1]!.id}`,
        },
      },
      (json) => JSON.parse(json) as { readonly id: string; readonly updatedAt: string },
    );
    expect(afterEnd).toEqual({ jobs: [], total: 12 });
  });

  it("rejects invalid page query boundaries", () => {
    database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, status TEXT, job_json TEXT)");
    const parse = (json: string) => JSON.parse(json) as unknown;

    expect(() =>
      queryMemoryJobPage(database!, { statuses: [], limit: 10, sortKeyPrefix: "episodic" }, parse),
    ).toThrow("Memory job page requires a status filter.");
    expect(() =>
      queryMemoryJobPage(
        database!,
        { statuses: ["completed"], limit: 0, sortKeyPrefix: "episodic" },
        parse,
      ),
    ).toThrow("Memory job page limit must be a positive safe integer.");
    expect(() =>
      queryMemoryJobPage(
        database!,
        { statuses: ["completed"], limit: 10, sortKeyPrefix: "" },
        parse,
      ),
    ).toThrow("Memory job page sort key prefix must not be empty.");
  });
});
