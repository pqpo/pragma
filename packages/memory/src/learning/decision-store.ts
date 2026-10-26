import { createHash } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { z } from "zod";
import { assertFreshSqliteDatabase } from "../storage/sqlite-migration-backup.ts";

export const LearningDecisionSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-learning-decision/v1"),
    outcome: z.enum(["accumulate", "duplicate", "unsupported", "create", "revise"]),
    reason: z.string().max(4000),
    targets: z.array(z.string().max(500)).max(3),
  })
  .strict();
export type LearningDecision = z.infer<typeof LearningDecisionSchema>;

/** Effective-content fingerprints ignore revision-only churn and incidental timestamps. */
export function learningFingerprint(value: unknown): string {
  const hash = createHash("sha256");
  if (Array.isArray(value)) {
    hash.update("array:");
    for (const digest of value.map(learningFingerprint).toSorted()) hash.update(digest);
  } else if (value !== null && typeof value === "object") {
    hash.update("object:");
    for (const [key, entry] of Object.entries(value)
      .filter(
        ([key, entry]) =>
          entry !== undefined &&
          !["observedAt", "bindingId", "valueScore", "revision"].includes(key),
      )
      .toSorted(([left], [right]) => left.localeCompare(right))) {
      hash.update(JSON.stringify(key));
      hash.update(learningFingerprint(entry));
    }
  } else hash.update(JSON.stringify(value) ?? "null");
  return hash.digest("hex");
}

export function createLearningDecisionStore(
  options: { readonly pragmaHome?: string | undefined },
  module: "knowledge" | "skill",
) {
  const dir = new PragmaPaths(options).memoryModuleDataRoot(`pragma.memory.${module}-learning`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "learning-decisions-v1.sqlite");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (version !== 0 && version !== 1) {
    db.close();
    throw new Error("unsupported_memory_learning_decision_version");
  }
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    if (version === 0) {
      assertFreshSqliteDatabase(db, "pragma.memory-learning-decisions");
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE decisions (fingerprint TEXT PRIMARY KEY, job_id TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX decisions_job ON decisions(job_id);
        CREATE TABLE plans (fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
    } else {
      // Existing authority must not be silently recreated after corruption.
      db.prepare("SELECT fingerprint,job_id,payload FROM decisions LIMIT 0").all();
      db.prepare("SELECT fingerprint,payload FROM plans LIMIT 0").all();
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let closed = false;
  return {
    readPlan(fingerprint: string): unknown {
      const row = db.prepare("SELECT payload FROM plans WHERE fingerprint=?").get(fingerprint) as
        { payload: string } | undefined;
      return row === undefined
        ? undefined
        : z
            .object({
              schemaVersion: z.literal("pragma.memory-learning-plan/v1"),
              plan: z.unknown(),
            })
            .strict()
            .parse(JSON.parse(row.payload)).plan;
    },
    discardPlan(fingerprint: string): void {
      db.prepare("DELETE FROM plans WHERE fingerprint=?").run(fingerprint);
    },
    writePlan(fingerprint: string, value: unknown): void {
      db.prepare(
        "INSERT INTO plans(fingerprint,payload) VALUES(?,?) ON CONFLICT(fingerprint) DO NOTHING",
      ).run(
        fingerprint,
        JSON.stringify({ schemaVersion: "pragma.memory-learning-plan/v1", plan: value }),
      );
    },
    has(fingerprint: string): boolean {
      return (
        db.prepare("SELECT 1 FROM decisions WHERE fingerprint=?").get(fingerprint) !== undefined
      );
    },
    read(jobId: string): LearningDecision | undefined {
      return readDecision(db, jobId);
    },
    write(
      fingerprint: string,
      jobId: string,
      input: Omit<LearningDecision, "schemaVersion">,
    ): void {
      const payload = LearningDecisionSchema.parse({
        ...input,
        schemaVersion: "pragma.memory-learning-decision/v1",
      });
      db.prepare(
        "INSERT INTO decisions(fingerprint,job_id,payload) VALUES(?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET job_id=excluded.job_id,payload=excluded.payload",
      ).run(fingerprint, jobId, JSON.stringify(payload));
      db.prepare("DELETE FROM plans WHERE fingerprint=?").run(fingerprint);
    },
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}

export function readLearningDecision(
  options: { readonly pragmaHome?: string | undefined },
  module: "knowledge" | "skill",
  jobId: string,
): LearningDecision | undefined {
  const path = join(
    new PragmaPaths(options).memoryModuleDataRoot(`pragma.memory.${module}-learning`),
    "learning-decisions-v1.sqlite",
  );
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if ((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version !== 1)
      throw new Error("unsupported_memory_learning_decision_version");
    return readDecision(db, jobId);
  } finally {
    db.close();
  }
}

function readDecision(db: DatabaseSync, jobId: string): LearningDecision | undefined {
  const row = db
    .prepare("SELECT payload FROM decisions WHERE job_id=? ORDER BY rowid DESC LIMIT 1")
    .get(jobId) as { payload: string } | undefined;
  return row === undefined ? undefined : LearningDecisionSchema.parse(JSON.parse(row.payload));
}
