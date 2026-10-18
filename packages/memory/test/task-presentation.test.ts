import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  readMemoryLearningTaskPresentation,
  writeMemoryLearningTaskPresentation,
} from "../src/learning/task-presentation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps source topics stable across reads, replaces them with planned names, and isolates watermarks", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "memory-task-title-"));
  roots.push(pragmaHome);
  const key = { module: "knowledge" as const, id: "job", sourceDigest: "a".repeat(64) };
  const sources = [
    {
      ref: { kind: "episodic" },
      title: "ContextStore token savings",
      body: "A long account of the run",
    },
    {
      ref: { kind: "semantic" },
      title: "internal.predicate: value",
      body: "Read large context in small sections.",
    },
  ];
  expect(writeMemoryLearningTaskPresentation({ pragmaHome }, key, { sources })).toBe(true);
  expect(readMemoryLearningTaskPresentation({ pragmaHome }, key)).toMatchObject({
    titles: ["ContextStore token savings", "Read large context in small sections."],
    topicCount: 2,
    planned: false,
  });
  expect(
    readMemoryLearningTaskPresentation({ pragmaHome }, { ...key, sourceDigest: "b".repeat(64) }),
  ).toBeUndefined();
  writeMemoryLearningTaskPresentation({ pragmaHome }, key, {
    sources,
    plannedTitles: ["Efficient ContextStore reading"],
  });
  writeMemoryLearningTaskPresentation({ pragmaHome }, key, { sources: [] });
  expect(readMemoryLearningTaskPresentation({ pragmaHome }, key)).toMatchObject({
    titles: ["Efficient ContextStore reading"],
    planned: true,
  });
  await rm(join(pragmaHome, "cache", "memory", "task-presentations-v1.sqlite"));
  expect(readMemoryLearningTaskPresentation({ pragmaHome }, key)).toBeUndefined();
});

it("bounds the disposable catalog and safely ignores future or damaged display data", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "memory-task-title-bound-"));
  roots.push(pragmaHome);
  const sources = [{ ref: { kind: "episodic" }, title: "Topic", body: "Body" }];
  for (let i = 0; i < 102; i++)
    writeMemoryLearningTaskPresentation(
      { pragmaHome },
      { module: "skill", id: `job-${i}`, sourceDigest: "a".repeat(64) },
      { sources },
    );
  const db = new DatabaseSync(join(pragmaHome, "cache", "memory", "task-presentations-v1.sqlite"));
  expect(db.prepare("SELECT count(*) AS count FROM presentations").get()?.["count"]).toBe(100);
  db.prepare("UPDATE presentations SET payload=? WHERE job_id=?").run(
    '{"schemaVersion":"future"}',
    "job-101",
  );
  db.close();
  expect(
    readMemoryLearningTaskPresentation(
      { pragmaHome },
      { module: "skill", id: "job-101", sourceDigest: "a".repeat(64) },
    ),
  ).toBeUndefined();
});
