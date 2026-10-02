import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, copyFile, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  withFileLock,
  RuntimeUsageObservedSchema,
  type RuntimeUsageObservation,
} from "@pragma/core";
import { z } from "zod";

const historical = z.object({
  schemaVersion: z.literal("pragma.local-host-usage/v1"),
  observations: z.record(z.string(), RuntimeUsageObservedSchema.shape.observation),
});
const authority = z.object({
  schemaVersion: z.literal("pragma.local-host-usage-storage/v1"),
  engine: z.literal("sqlite"),
});
const journal = z.object({
  schemaVersion: z.literal("pragma.local-host-usage-conversion/v1"),
  stage: z.enum(["import", "publish"]),
});
async function read(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function sync(path: string) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await sync(dirname(path));
}
function initialize(db: DatabaseSync) {
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (version > 1) throw new Error("Unsupported usage ledger database version.");
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;");
  if (version === 1) {
    db.prepare("SELECT id,signature,occurred_at,payload FROM observations LIMIT 0");
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,signature TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS observations_date ON observations(occurred_at,id);
    PRAGMA user_version=1;`);
}
function signature(observation: RuntimeUsageObservation) {
  return createHash("sha256").update(JSON.stringify(observation)).digest("hex");
}
function insert(db: DatabaseSync, observation: RuntimeUsageObservation) {
  const hash = signature(observation);
  const existing = db
    .prepare("SELECT signature FROM observations WHERE id=?")
    .get(observation.observationId) as { signature: string } | undefined;
  if (existing !== undefined) {
    if (existing.signature !== hash)
      throw new Error(`Conflicting usage observation: ${observation.observationId}.`);
    return;
  }
  db.prepare("INSERT INTO observations VALUES(?,?,?,?)").run(
    observation.observationId,
    hash,
    observation.occurredAt,
    JSON.stringify(observation),
  );
}
/** Legacy JSON is read only here, before the durable authority switch. */
export async function executeUsageLedger(path: string, operation: string, input?: unknown) {
  return await withFileLock(
    `${path}.lock`,
    async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const databasePath = `${path}.sqlite`;
      const markerPath = `${path}.authority.json`;
      const journalPath = `${path}.conversion.json`;
      const marker = await read(markerPath);
      if (marker === undefined) {
        const pending = await read(journalPath);
        if (pending !== undefined) journal.parse(pending);
        const source = await read(path);
        if (source !== undefined) historical.parse(source);
        await atomic(journalPath, {
          schemaVersion: "pragma.local-host-usage-conversion/v1",
          stage: "import",
        });
        if (source !== undefined) {
          if (!existsSync(`${path}.backup`)) {
            const backupTemporary = `${path}.backup-tmp`;
            await copyFile(path, backupTemporary);
            await sync(backupTemporary);
            await rename(backupTemporary, `${path}.backup`);
            await sync(dirname(path));
          }
        }
        const temporary = `${databasePath}.converting`;
        for (const suffix of ["", "-wal", "-shm"])
          await rm(`${temporary}${suffix}`, { force: true });
        const db = new DatabaseSync(temporary);
        try {
          initialize(db);
          db.exec("BEGIN IMMEDIATE");
          if (source !== undefined)
            for (const [id, observation] of Object.entries(historical.parse(source).observations)) {
              if (id !== observation.observationId)
                throw new Error("Usage observation identity mismatch.");
              insert(db, observation);
            }
          db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
        } finally {
          db.close();
        }
        await atomic(journalPath, {
          schemaVersion: "pragma.local-host-usage-conversion/v1",
          stage: "publish",
        });
        await sync(temporary);
        await rename(temporary, databasePath);
        await sync(dirname(path));
        await atomic(markerPath, {
          schemaVersion: "pragma.local-host-usage-storage/v1",
          engine: "sqlite",
        });
        await rm(journalPath, { force: true });
      } else {
        authority.parse(marker);
        if (!existsSync(databasePath))
          throw Object.assign(new Error("Usage authority database is missing."), {
            code: "USAGE_LEDGER_AUTHORITY_MISSING",
          });
        const pending = await read(journalPath);
        if (pending !== undefined) {
          journal.parse(pending);
          await rm(journalPath, { force: true });
        }
      }
      const db = new DatabaseSync(databasePath);
      try {
        initialize(db);
        switch (operation) {
          case "record":
          case "reconcile": {
            const observations =
              operation === "record"
                ? [RuntimeUsageObservedSchema.shape.observation.parse(input)]
                : RuntimeUsageObservedSchema.shape.observation.array().parse(input);
            db.exec("BEGIN IMMEDIATE");
            try {
              for (const observation of observations) insert(db, observation);
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
            return;
          }
          case "list":
            return (
              db.prepare("SELECT payload FROM observations ORDER BY occurred_at,id").all() as {
                payload: string;
              }[]
            ).map((row) =>
              RuntimeUsageObservedSchema.shape.observation.parse(JSON.parse(row.payload)),
            );
          default:
            throw new Error("Unsupported usage ledger operation.");
        }
      } finally {
        db.close();
      }
    },
    { operation: "local-host-usage" },
  );
}
