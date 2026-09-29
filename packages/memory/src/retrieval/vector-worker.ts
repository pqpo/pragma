import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { EmbeddingProfileSchema } from "./profile.ts";

const DataSchema = z.object({ path: z.string(), readOnly: z.boolean() });
const config = DataSchema.parse(workerData);
if (!config.readOnly) mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(config.path, { readOnly: config.readOnly });
const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
if (
  version === 0 &&
  db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .get() !== undefined
)
  throw new Error("embedding_index_unversioned");
if (version > 1) throw new Error("embedding_index_future_version");
if (!config.readOnly) {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, dimensions INTEGER, response_model TEXT, status TEXT NOT NULL, cursor_episode TEXT, cursor_fact TEXT);
 CREATE TABLE IF NOT EXISTS segments (generation TEXT NOT NULL,module TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,segment_id TEXT NOT NULL,field_path TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,text_hash TEXT NOT NULL,vector BLOB NOT NULL,generated_at TEXT NOT NULL,PRIMARY KEY(generation,module,memory_id,segment_id));
 CREATE INDEX IF NOT EXISTS segments_memory ON segments(generation,module,memory_id);
 CREATE TABLE IF NOT EXISTS expirations (generation TEXT NOT NULL,module TEXT NOT NULL,memory_id TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(generation,module,memory_id));
 CREATE INDEX IF NOT EXISTS expirations_deadline ON expirations(expires_at);
 CREATE TABLE IF NOT EXISTS failures (generation TEXT NOT NULL,module TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,code TEXT NOT NULL,PRIMARY KEY(generation,module,memory_id));
 CREATE TABLE IF NOT EXISTS active (singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL);
 PRAGMA user_version=1;`);
} else if (version !== 1) throw new Error("embedding_index_unavailable");
const RequestSchema = z.object({
  id: z.number().int(),
  operation: z.string(),
  payload: z.record(z.string(), z.unknown()),
  cancel: z.instanceof(SharedArrayBuffer),
});
function transaction<T>(run: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const value = run();
    db.exec("COMMIT;");
    return value;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
function processRequest(op: string, p: Record<string, unknown>, cancel: Int32Array): unknown {
  const generation = typeof p["generation"] === "string" ? p["generation"] : "";
  const module = typeof p["module"] === "string" ? p["module"] : "";
  const memoryId = typeof p["memoryId"] === "string" ? p["memoryId"] : "";
  switch (op) {
    case "ensure": {
      const profile = EmbeddingProfileSchema.parse(p["profile"]);
      db.prepare(
        "INSERT OR IGNORE INTO generations(id,profile_json,status) VALUES (?,?,'building')",
      ).run(profile.fingerprint, JSON.stringify(profile));
      return null;
    }
    case "binding":
      return (
        db
          .prepare(
            "SELECT g.id,g.profile_json AS profileJson,g.dimensions,g.response_model AS responseModel,g.status FROM generations g JOIN active a ON a.generation=g.id WHERE g.dimensions IS NOT NULL AND g.response_model IS NOT NULL",
          )
          .get() ?? null
      );
    case "generation":
      return db.prepare("SELECT * FROM generations WHERE id=?").get(generation) ?? null;
    case "hashes":
      return db
        .prepare(
          "SELECT segment_id AS segmentId,text_hash AS textHash FROM segments WHERE generation=? AND module=? AND memory_id=?",
        )
        .all(generation, module, memoryId);
    case "replace":
      return transaction(() => {
        const revision = z.number().int().positive().parse(p["revision"]);
        const rows = z
          .array(
            z.object({
              segmentId: z.string(),
              fieldPath: z.string(),
              start: z.number(),
              end: z.number(),
              textHash: z.string(),
              vector: z.instanceof(Float32Array).optional(),
            }),
          )
          .parse(p["segments"]);
        const dimension = z.number().int().positive().parse(p["dimensions"]),
          responseModel = z.string().parse(p["responseModel"]);
        const meta = db
          .prepare("SELECT dimensions,response_model AS model FROM generations WHERE id=?")
          .get(generation) as { dimensions: number | null; model: string | null } | undefined;
        if (
          meta === undefined ||
          (meta.dimensions !== null && meta.dimensions !== dimension) ||
          (meta.model !== null && meta.model !== responseModel)
        )
          throw new Error("embedding_space_changed");
        db.prepare("UPDATE generations SET dimensions=?,response_model=? WHERE id=?").run(
          dimension,
          responseModel,
          generation,
        );
        const retained = new Set(rows.map((row) => row.segmentId));
        const existing = db
          .prepare(
            "SELECT segment_id AS segmentId,text_hash AS textHash,vector,generated_at AS generatedAt FROM segments WHERE generation=? AND module=? AND memory_id=?",
          )
          .all(generation, module, memoryId) as Array<{
          segmentId: string;
          textHash: string;
          vector: Uint8Array;
          generatedAt: string;
        }>;
        for (const row of rows) {
          const old = existing.find((value) => value.textHash === row.textHash);
          const vector =
            row.vector === undefined
              ? old?.vector
              : Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
          if (vector === undefined || vector.byteLength !== dimension * 4)
            throw new Error("embedding_vector_missing");
          db.prepare("INSERT OR REPLACE INTO segments VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
            generation,
            module,
            memoryId,
            revision,
            row.segmentId,
            row.fieldPath,
            row.start,
            row.end,
            row.textHash,
            vector,
            row.vector === undefined ? old!.generatedAt : new Date().toISOString(),
          );
        }
        for (const old of existing)
          if (!retained.has(old.segmentId))
            db.prepare(
              "DELETE FROM segments WHERE generation=? AND module=? AND memory_id=? AND segment_id=?",
            ).run(generation, module, memoryId, old.segmentId);
        db.prepare("DELETE FROM failures WHERE generation=? AND module=? AND memory_id=?").run(
          generation,
          module,
          memoryId,
        );
        const expiresAt = z.string().datetime().optional().parse(p["expiresAt"]);
        if (expiresAt === undefined)
          db.prepare("DELETE FROM expirations WHERE generation=? AND module=? AND memory_id=?").run(
            generation,
            module,
            memoryId,
          );
        else
          db.prepare("INSERT OR REPLACE INTO expirations VALUES (?,?,?,?)").run(
            generation,
            module,
            memoryId,
            expiresAt,
          );
        return null;
      });
    case "delete":
      return transaction(() => {
        const all = p["allGenerations"] === true;
        for (const table of ["expirations", "segments", "failures"])
          db.prepare(
            `DELETE FROM ${table} WHERE ${all ? "" : "generation=? AND "}module=? AND memory_id=?`,
          ).run(...(all ? [] : [generation]), module, memoryId);
        return null;
      });
    case "expire":
      return transaction(() => {
        const now = z.string().datetime().parse(p["now"]);
        for (const table of ["segments", "failures"])
          db.prepare(
            `DELETE FROM ${table} WHERE EXISTS (SELECT 1 FROM expirations e WHERE e.generation=${table}.generation AND e.module=${table}.module AND e.memory_id=${table}.memory_id AND e.expires_at<=?)`,
          ).run(now);
        db.prepare("DELETE FROM expirations WHERE expires_at<=?").run(now);
        return null;
      });
    case "failure":
      db.prepare("INSERT OR REPLACE INTO failures VALUES (?,?,?,?,?)").run(
        generation,
        module,
        memoryId,
        z.number().parse(p["revision"]),
        z.string().parse(p["code"]),
      );
      return null;
    case "reset":
      return transaction(() => {
        db.prepare("DELETE FROM expirations WHERE generation=?").run(generation);
        db.prepare("DELETE FROM segments WHERE generation=?").run(generation);
        db.prepare("DELETE FROM failures WHERE generation=?").run(generation);
        db.prepare("DELETE FROM active WHERE generation=?").run(generation);
        db.prepare("DELETE FROM generations WHERE id=?").run(generation);
        return null;
      });
    case "failed":
      return db
        .prepare("SELECT memory_id AS memoryId FROM failures WHERE generation=? AND module=?")
        .all(generation, module);
    case "cursor":
      db.prepare(
        module === "episodic"
          ? "UPDATE generations SET cursor_episode=? WHERE id=?"
          : "UPDATE generations SET cursor_fact=? WHERE id=?",
      ).run(memoryId, generation);
      return null;
    case "activate":
      return transaction(() => {
        const failures = (
          db.prepare("SELECT count(*) AS n FROM failures WHERE generation=?").get(generation) as {
            n: number;
          }
        ).n;
        if (failures !== 0) throw new Error("embedding_backfill_incomplete");
        db.prepare("UPDATE generations SET status='ready' WHERE id=?").run(generation);
        db.prepare("INSERT OR REPLACE INTO active VALUES (1,?)").run(generation);
        db.prepare("DELETE FROM expirations WHERE generation<>?").run(generation);
        db.prepare("DELETE FROM segments WHERE generation<>?").run(generation);
        db.prepare("DELETE FROM failures WHERE generation<>?").run(generation);
        db.prepare("DELETE FROM generations WHERE id<>?").run(generation);
        return null;
      });
    case "stats": {
      return {
        generation,
        segments: (
          db.prepare("SELECT count(*) AS n FROM segments WHERE generation=?").get(generation) as {
            n: number;
          }
        ).n,
        memories: (
          db
            .prepare(
              "SELECT count(*) AS n FROM (SELECT DISTINCT module,memory_id FROM segments WHERE generation=?)",
            )
            .get(generation) as { n: number }
        ).n,
        failed: (
          db.prepare("SELECT count(*) AS n FROM failures WHERE generation=?").get(generation) as {
            n: number;
          }
        ).n,
      };
    }
    case "search": {
      const vector = z.instanceof(Float32Array).parse(p["vector"]);
      const allowed = z
        .array(z.object({ id: z.string(), revision: z.number() }))
        .parse(p["allowed"]);
      const ids = new Map(allowed.map((value) => [value.id, value.revision]));
      const dimensions = (
        db.prepare("SELECT dimensions FROM generations WHERE id=?").get(generation) as
          { dimensions: number } | undefined
      )?.dimensions;
      if (dimensions !== vector.length) throw new Error("embedding_space_changed");
      const result: Array<{
        memoryId: string;
        revision: number;
        segmentId: string;
        fieldPath: string;
        textHash: string;
        start: number;
        end: number;
        similarity: number;
      }> = [];
      const limit = z.number().int().min(1).max(300).parse(p["limit"]);
      const rows = db
        .prepare(
          "SELECT memory_id AS memoryId,revision,segment_id AS segmentId,field_path AS fieldPath,text_hash AS textHash,start_offset AS start,end_offset AS end,vector FROM segments WHERE generation=? AND module=?",
        )
        .iterate(generation, module);
      for (const raw of rows) {
        if (Atomics.load(cancel, 0) !== 0) throw new Error("embedding_cancelled");
        const row = raw as unknown as {
          memoryId: string;
          revision: number;
          segmentId: string;
          fieldPath: string;
          textHash: string;
          start: number;
          end: number;
          vector: Uint8Array;
        };
        if (ids.get(row.memoryId) !== row.revision) continue;
        const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
        let similarity = 0;
        for (let i = 0; i < vector.length; i++)
          similarity += vector[i]! * view.getFloat32(i * 4, true);
        if (!Number.isFinite(similarity)) continue;
        const { vector: _vector, ...hit } = row;
        void _vector;
        const previous = result.findIndex((value) => value.memoryId === hit.memoryId);
        if (previous >= 0) {
          if (result[previous]!.similarity >= similarity) continue;
          result.splice(previous, 1);
        }
        result.push({ ...hit, similarity });
        result.sort(
          (a, b) =>
            b.similarity - a.similarity ||
            a.memoryId.localeCompare(b.memoryId) ||
            a.segmentId.localeCompare(b.segmentId),
        );
        if (result.length > limit) result.pop();
      }
      return result;
    }
    case "close":
      db.close();
      return null;
    default:
      throw new Error("embedding_worker_request_invalid");
  }
}
parentPort?.on("message", (raw: unknown) => {
  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) return;
  const request = parsed.data;
  try {
    const value = processRequest(
      request.operation,
      request.payload,
      new Int32Array(request.cancel),
    );
    parentPort?.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    const message =
      error instanceof Error && /^embedding_[a-z_]+$/u.test(error.message)
        ? error.message
        : "embedding_index_unavailable";
    parentPort?.postMessage({ id: request.id, ok: false, code: message });
  }
});
parentPort?.postMessage({ ready: true });
