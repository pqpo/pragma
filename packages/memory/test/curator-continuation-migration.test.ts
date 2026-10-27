import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { afterEach, expect, it } from "vitest";
import { createMemoryExtractionSessionStore } from "../src/pipeline/extraction-session/store.ts";
import {
  hasMemoryExtractionReceipt,
  hasPendingMemoryExtractionContinuation,
} from "../src/pipeline/extraction-session/store.ts";

const roots: string[] = [];
const missionId = "11111111-1111-4111-a111-111111111111";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-curator-v4-"));
  roots.push(pragmaHome);
  const path = new PragmaPaths({ pragmaHome }).memoryExtractionSessions();
  await mkdir(dirname(path), { recursive: true });
  await copyFile(new URL("./fixtures/curator-sessions/v3.sqlite", import.meta.url), path);
  return { pragmaHome, path, store: createMemoryExtractionSessionStore({ pragmaHome }) };
}
function state(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.parse(
      (db.prepare("SELECT state_json FROM sessions").get() as { state_json: string }).state_json,
    );
  } finally {
    db.close();
  }
}

it("upgrades an actual v3 reservation on access, preserves staged work and receipts, and resumes without spending another continuation", async () => {
  const { pragmaHome, path, store } = await fixture();
  const original = state(path);
  const bytes = await readFile(path);
  expect(hasMemoryExtractionReceipt({ pragmaHome }, "semantic", "fact-job", "w")).toBe(true);
  expect(
    hasPendingMemoryExtractionContinuation({ pragmaHome }, "episodic", "episode-job", "w"),
  ).toBe(true);
  expect(await readFile(path)).toEqual(bytes);
  expect(original.pendingContinuation.requestId[14]).toBe("8");
  const session = (await store.forMission(missionId))!;
  const pending = (await session.executionState()).pendingContinuation!;
  expect(pending.requestId[14]).toBe("4");
  expect(state(path)).toEqual({
    ...original,
    schemaVersion: "pragma.memory-curator-session/v4",
    pendingContinuation: { ...original.pendingContinuation, requestId: pending.requestId },
  });
  expect(state(`${path}.v3.backup`)).toEqual(original);
  expect(
    await session.reserveContinuation({ previousExecutionId: "ignored", prompt: "ignored" }),
  ).toEqual(pending);
  expect((await session.executionState()).continuations).toBe(1);
  expect(hasMemoryExtractionReceipt({ pragmaHome }, "semantic", "fact-job", "w")).toBe(true);
  expect(
    hasPendingMemoryExtractionContinuation({ pragmaHome }, "episodic", "episode-job", "w"),
  ).toBe(true);
  const migrated = await readFile(path);
  await createMemoryExtractionSessionStore({ pragmaHome }).forMission(missionId);
  expect(await readFile(path)).toEqual(migrated);
  await session.acknowledgeContinuation(pending.requestId);
  await session.call("submit_episode_part", {
    part: "summary",
    text: "Recorded preference",
    evidence: ["e1"],
  });
  await session.call("submit_episode_part", {
    part: "outcome",
    status: "succeeded",
    summary: "Done",
    evidence: ["e1"],
  });
  await session.call("finish_episodic_extraction", { language: "en", valueScore: 0.8 });
  expect(await session.completed()).toBe(true);
});

it("rolls back interruption and replays with the same backup and request identity", async () => {
  const { path, store } = await fixture();
  const original = state(path);
  let db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER fail_v4 BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'interrupted-v4'); END",
  );
  db.close();
  await expect(store.forMission(missionId)).rejects.toThrow("interrupted-v4");
  expect(state(path)).toEqual(original);
  const backup = await readFile(`${path}.v3.backup`);
  db = new DatabaseSync(path);
  expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
  db.exec("DROP TRIGGER fail_v4");
  db.close();
  await store.forMission(missionId);
  expect(await readFile(`${path}.v3.backup`)).toEqual(backup);
  expect(state(path).pendingContinuation.requestId).toBe(
    `${original.pendingContinuation.requestId.slice(0, 14)}4${original.pendingContinuation.requestId.slice(15)}`,
  );
  await stat(`${path}.v3.backup`);
});

it("preserves an already compatible request identity during upgrade", async () => {
  const { path, store } = await fixture();
  const db = new DatabaseSync(path);
  const requestId = "33333333-3333-4333-a333-333333333333";
  db.prepare(
    "UPDATE sessions SET state_json=json_set(state_json,'$.pendingContinuation.requestId',?)",
  ).run(requestId);
  db.close();
  const original = state(path);
  const session = (await store.forMission(missionId))!;
  expect((await session.executionState()).pendingContinuation?.requestId).toBe(requestId);
  expect(state(path)).toEqual({ ...original, schemaVersion: "pragma.memory-curator-session/v4" });
});

it("rolls back all records when a later row fails, then replays the complete migration", async () => {
  const { path, store } = await fixture();
  const original = state(path);
  let db = new DatabaseSync(path);
  const second = { ...original, key: "second-session", jobId: "second-job" };
  db.prepare("INSERT INTO sessions(key,module,job_id,updated_at,state_json) VALUES(?,?,?,?,?)").run(
    second.key,
    second.module,
    second.jobId,
    second.updatedAt,
    JSON.stringify(second),
  );
  db.exec(
    "CREATE TRIGGER fail_second_v4 BEFORE UPDATE ON sessions WHEN NEW.key='second-session' BEGIN SELECT RAISE(ABORT,'interrupted-second-row'); END",
  );
  db.close();
  await expect(store.forMission(missionId)).rejects.toThrow("interrupted-second-row");
  db = new DatabaseSync(path);
  const rows = () =>
    (
      db.prepare("SELECT state_json FROM sessions ORDER BY rowid").all() as { state_json: string }[]
    ).map((row) => JSON.parse(row.state_json));
  expect(rows()).toEqual([original, second]);
  expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
  db.exec("DROP TRIGGER fail_second_v4");
  db.close();
  await store.forMission(missionId);
  db = new DatabaseSync(path);
  expect(rows()).toEqual(
    [original, second].map((old) => ({
      ...old,
      schemaVersion: "pragma.memory-curator-session/v4",
      pendingContinuation: {
        ...old.pendingContinuation,
        requestId: `${old.pendingContinuation.requestId.slice(0, 14)}4${old.pendingContinuation.requestId.slice(15)}`,
      },
    })),
  );
  expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
  db.close();
});

it.each(["future", "corrupt"])("preserves and rejects %s storage", async (kind) => {
  const { path, store } = await fixture();
  const db = new DatabaseSync(path);
  db.exec(
    kind === "future"
      ? "PRAGMA user_version=99"
      : "UPDATE sessions SET state_json=json_set(state_json,'$.pendingContinuation.requestId','broken')",
  );
  db.close();
  const before = await readFile(path);
  await expect(store.forMission(missionId)).rejects.toThrow();
  expect(await readFile(path)).toEqual(before);
});
