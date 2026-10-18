import { mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { z } from "zod";
import { redactMemoryProjection } from "../retrieval/projection.ts";

const PresentationSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-task-presentation/v1"),
    titles: z.array(z.string().min(1).max(160)).min(1).max(100),
    topicCount: z.number().int().positive().max(100),
    planned: z.boolean(),
  })
  .strict();
export type MemoryLearningTaskPresentation = z.infer<typeof PresentationSchema>;
type Key = {
  readonly module: "knowledge" | "skill";
  readonly id: string;
  readonly sourceDigest: string;
};
type Options = { readonly pragmaHome?: string | undefined };

function path(options: Options): string {
  return join(new PragmaPaths(options).memoryCacheRoot(), "task-presentations-v1.sqlite");
}

/** Disposable display snapshots; never an execution or recovery authority. */
export function readMemoryLearningTaskPresentation(
  options: Options,
  key: Key,
): MemoryLearningTaskPresentation | undefined {
  let db: DatabaseSync | undefined;
  try {
    if (!existsSync(path(options))) return undefined;
    db = new DatabaseSync(path(options), { readOnly: true });
    const row = db
      .prepare("SELECT payload FROM presentations WHERE module=? AND job_id=? AND source_digest=?")
      .get(key.module, key.id, key.sourceDigest) as { payload: string } | undefined;
    if (row === undefined) return undefined;
    const parsed = PresentationSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export function writeMemoryLearningTaskPresentation(
  options: Options,
  key: Key,
  input: {
    readonly sources: readonly {
      readonly ref: { readonly kind: string };
      readonly title: string;
      readonly body: string;
    }[];
    readonly plannedTitles?: readonly string[];
  },
): boolean {
  let db: DatabaseSync | undefined;
  try {
    const previous = readMemoryLearningTaskPresentation(options, key);
    const planned = input.plannedTitles !== undefined || previous?.planned === true;
    const titles = [
      ...new Set(
        (planned
          ? [...(previous?.planned ? previous.titles : []), ...(input.plannedTitles ?? [])]
          : input.sources.map((source) =>
              source.ref.kind === "episodic" ? source.title : source.body,
            )
        )
          .map((text) => redactMemoryProjection(text).replace(/\s+/gu, " ").trim())
          .filter(Boolean),
      ),
    ];
    if (titles.length === 0) return false;
    const payload = PresentationSchema.parse({
      schemaVersion: "pragma.memory-task-presentation/v1",
      titles: titles.slice(0, 100).map((title) => [...title].slice(0, 80).join("")),
      topicCount: Math.min(100, titles.length),
      planned,
    });
    const root = new PragmaPaths(options).memoryCacheRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path(options));
    chmodSync(path(options), 0o600);
    db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS presentations(module TEXT NOT NULL, job_id TEXT NOT NULL,
        source_digest TEXT NOT NULL, payload TEXT NOT NULL, touched_at INTEGER NOT NULL,
        PRIMARY KEY(module, job_id, source_digest));`);
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO presentations VALUES(?,?,?,?,?) ON CONFLICT(module,job_id,source_digest)
      DO UPDATE SET payload=excluded.payload,touched_at=excluded.touched_at`,
    ).run(key.module, key.id, key.sourceDigest, JSON.stringify(payload), Date.now());
    db.exec(
      "DELETE FROM presentations WHERE rowid NOT IN (SELECT rowid FROM presentations ORDER BY touched_at DESC,rowid DESC LIMIT 100)",
    );
    db.exec("COMMIT");
    return true;
  } catch {
    // A missing/corrupt display cache must not fail extraction or revise authoritative jobs.
    return false;
  } finally {
    db?.close();
  }
}
