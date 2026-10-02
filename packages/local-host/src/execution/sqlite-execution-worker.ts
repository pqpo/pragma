import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { executionStorageConversionMigrationChain } from "@pragma/core";
import { executeUsageLedger } from "../usage-ledger-database.ts";
import { executeUsageReceipt } from "../usage-receipt-database.ts";
import { executeMissionReceipt } from "../mission-delivery-receipts.ts";
import { openUsageDatabase, type DesktopUsageStore } from "../usage-database.ts";
import type { UsageUpdate } from "@pragma/shared";
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, open } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  PragmaPaths,
  encodePragmaPathSegment,
  withFileLock,
  recoverLegacyExecutionOwner,
  executionTransactionRules as rules,
  ExecutionVersionConflictError,
  type ExecutionCommitRequest,
  type ExecutionCommitResult,
} from "@pragma/core";
import {
  ExecutionRecordSchema,
  InvocationSchema,
  AgentInstanceSchema,
  RuntimeContextRecordSchema,
  ExecutionEventSchema,
  CanonicalEventEnvelopeSchema,
  isTerminalExecutionStatus,
  type ExecutionRecord,
  type Invocation,
  type AgentInstance,
  type RuntimeContextRecord,
  type ExecutionEvent,
  type CanonicalEventEnvelope,
} from "@pragma/shared";

const port = parentPort!;
let paths: PragmaPaths;
const authoritySchema = z
  .object({
    schemaVersion: z.literal("pragma.execution-storage/v1"),
    engine: z.literal("sqlite"),
    executionId: z.string(),
  })
  .strict();
const journalSchema = {
  parse: (value: unknown) => executionStorageConversionMigrationChain.upgrade(value).value,
};
const receiptsSchema = z.array(
  z.object({
    commitId: z.string(),
    signature: z.string(),
    eventIds: z.array(z.string()),
    committedVersion: z.number(),
  }),
);
const databases = new Map<string, { database: DatabaseSync; touchedAt: number }>();

function close(id: string): void {
  databases.get(id)?.database.close();
  databases.delete(id);
}
function json(file: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  const directory = await open(dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function durableBackup(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.backup-tmp`;
  await copyFile(source, temporary);
  const file = await open(temporary, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
  const directory = await open(dirname(destination), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function initialize(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version !== 0 && version.user_version !== 1)
    throw new Error("Unsupported Execution database version.");
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100;
    CREATE TABLE IF NOT EXISTS execution(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invocations(id TEXT PRIMARY KEY, context_id TEXT NOT NULL, agent_id TEXT, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS invocation_context ON invocations(context_id);
    CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, context_id TEXT NOT NULL, owner_context_id TEXT NOT NULL, active_invocation_id TEXT, payload TEXT NOT NULL, UNIQUE(owner_context_id,context_id));
    CREATE INDEX IF NOT EXISTS agent_active ON agents(active_invocation_id);
    CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, signature TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    PRAGMA user_version=1;`);
}
function database(id: string, create = false): DatabaseSync {
  const cached = databases.get(id);
  if (cached !== undefined) {
    cached.touchedAt = Date.now();
    return cached.database;
  }
  if (!create && !existsSync(paths.executionDatabase(id)))
    throw new Error("Execution database is missing.");
  const db = new DatabaseSync(paths.executionDatabase(id));
  try {
    // Opening WAL metadata can itself contend with another connection. Apply
    // the existing lock policy before the first read, not after user_version.
    db.exec("PRAGMA busy_timeout=100;");
    if (create) initialize(db);
    else {
      const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 1) throw new Error("Unsupported Execution database version.");
      db.exec("PRAGMA synchronous=FULL;");
    }
  } catch (error) {
    db.close();
    throw error;
  }
  databases.set(id, { database: db, touchedAt: Date.now() });
  while (databases.size > 32) close(databases.keys().next().value!);
  return db;
}
function read<T>(db: DatabaseSync, table: string, id: string): T | undefined {
  const row = db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(id) as
    { payload: string } | undefined;
  if (row === undefined) return undefined;
  const schema = {
    execution: ExecutionRecordSchema,
    invocations: InvocationSchema,
    agents: AgentInstanceSchema,
    contexts: RuntimeContextRecordSchema,
    events: ExecutionEventSchema,
  }[table];
  const value: unknown = JSON.parse(row.payload);
  return (schema === undefined ? value : schema.parse(value)) as T;
}
function list<T>(db: DatabaseSync, table: string): T[] {
  return (
    db.prepare(`SELECT payload FROM ${table} ORDER BY rowid`).all() as { payload: string }[]
  ).map((row) => {
    const value: unknown = JSON.parse(row.payload);
    const schema = {
      execution: ExecutionRecordSchema,
      invocations: InvocationSchema,
      agents: AgentInstanceSchema,
      contexts: RuntimeContextRecordSchema,
      events: ExecutionEventSchema,
      outbox: CanonicalEventEnvelopeSchema,
    }[table];
    return (schema === undefined ? value : schema.parse(value)) as T;
  });
}
function put(db: DatabaseSync, table: string, id: string, value: unknown): void {
  db.prepare(
    `INSERT INTO ${table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
  ).run(id, JSON.stringify(value));
}
function putInvocation(db: DatabaseSync, invocation: Invocation): void {
  db.prepare(
    `INSERT INTO invocations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET context_id=excluded.context_id, agent_id=excluded.agent_id,payload=excluded.payload`,
  ).run(
    invocation.invocationId,
    invocation.contextId,
    invocation.agentId ?? null,
    JSON.stringify(invocation),
  );
}
function putAgent(db: DatabaseSync, agent: AgentInstance): void {
  db.prepare(
    `INSERT INTO agents VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET context_id=excluded.context_id,owner_context_id=excluded.owner_context_id,active_invocation_id=excluded.active_invocation_id,payload=excluded.payload`,
  ).run(
    agent.agentId,
    agent.contextId,
    agent.ownerContextId,
    agent.activeInvocationId ?? null,
    JSON.stringify(agent),
  );
}
function insertEvent(db: DatabaseSync, event: ExecutionEvent): void {
  db.prepare("INSERT INTO events VALUES(?,?,?)").run(
    event.cursor.sequence,
    event.eventId,
    JSON.stringify(event),
  );
}
function insertOutbox(db: DatabaseSync, event: CanonicalEventEnvelope): void {
  const source = ExecutionEventSchema.parse(event.payload);
  db.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?)").run(
    source.cursor.sequence,
    event.eventId,
    JSON.stringify(event),
  );
}
const benchmarkEnabled = process.env.PRAGMA_STORAGE_BENCHMARK === "1";
const writeStarts = new WeakMap<DatabaseSync, number>();
const requestStarts = new WeakMap<Request, number>();
let benchmarkMetrics = {
  writes: 0,
  lockWaitMs: 0,
  maxLockWaitMs: 0,
  writeLockHeldMs: 0,
  maxWriteLockHeldMs: 0,
  requests: 0,
  queueWaitMs: 0,
  maxQueueWaitMs: 0,
};
function finishWrite(db: DatabaseSync, sql: string): void {
  // A failed COMMIT can leave the transaction holding its lock; count through
  // the successful ROLLBACK instead of ending the sample at the failed commit.
  db.exec(sql);
  if (benchmarkEnabled) {
    const started = writeStarts.get(db);
    if (started !== undefined) {
      const held = performance.now() - started;
      benchmarkMetrics.writes++;
      benchmarkMetrics.writeLockHeldMs += held;
      benchmarkMetrics.maxWriteLockHeldMs = Math.max(benchmarkMetrics.maxWriteLockHeldMs, held);
      writeStarts.delete(db);
    }
  }
}
async function beginWrite(db: DatabaseSync): Promise<void> {
  const started = benchmarkEnabled ? performance.now() : 0;
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE;");
      if (benchmarkEnabled) {
        const acquired = performance.now();
        const waited = acquired - started;
        benchmarkMetrics.lockWaitMs += waited;
        benchmarkMetrics.maxLockWaitMs = Math.max(benchmarkMetrics.maxLockWaitMs, waited);
        writeStarts.set(db, acquired);
      }
      return;
    } catch (error) {
      const failure = error as Error & { errcode?: number };
      if (![5, 6].includes(failure.errcode ?? 0) || attempt >= 3) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}
function readSnapshot<T>(db: DatabaseSync, read: () => T): T {
  db.exec("BEGIN;");
  try {
    const result = read();
    finishWrite(db, "COMMIT;");
    return result;
  } catch (error) {
    finishWrite(db, "ROLLBACK;");
    throw error;
  }
}

async function registerPending(id: string): Promise<void> {
  const file = paths.executionCanonicalPending(id);
  if (existsSync(file)) return;
  const idle = paths.executionCanonicalIdleRegistration(id);
  if (existsSync(idle)) {
    await rename(idle, file);
    const directory = await open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return;
  }
  if (!existsSync(file))
    await atomic(
      file,
      authoritySchema.parse({
        schemaVersion: "pragma.execution-storage/v1",
        engine: "sqlite",
        executionId: id,
      }),
    );
}

/** Historical recovery is invoked exclusively at the conversion boundary. */
async function prepare(id: string): Promise<boolean> {
  const marker = json(paths.executionStorageAuthority(id));
  if (marker !== undefined) {
    const parsed = authoritySchema.parse(marker);
    if (parsed.executionId !== id || !existsSync(paths.executionDatabase(id)))
      throw new Error("Execution storage authority is incomplete.");
    const conversion = json(paths.executionStorageConversion(id));
    if (conversion !== undefined)
      return await withFileLock(paths.executionLock(id), async () => {
        const journal = journalSchema.parse(conversion);
        if (journal.executionId !== id) throw new Error("Execution conversion owner mismatch.");
        for (const name of journal.handoffNames ?? []) {
          if (basename(name) !== name || !name.startsWith(`${encodePragmaPathSegment(id)}.`))
            throw new Error("Conversion handoff owner mismatch.");
          await rm(join(paths.canonicalEventHandoffsRoot(), name), { force: true });
        }
        await rm(paths.executionStorageConversion(id), { force: true });
        return true;
      });
    return true;
  }
  const initialization = json(paths.executionStorageInitialization(id));
  if (initialization !== undefined)
    return await withFileLock(paths.executionLock(id), async () => {
      const init = z
        .object({
          schemaVersion: z.literal("pragma.execution-storage-initialization/v1"),
          executionId: z.literal(id),
          record: ExecutionRecordSchema,
          root: InvocationSchema,
        })
        .parse(initialization);
      const db = database(id, true);
      if (read(db, "execution", id) === undefined) {
        await beginWrite(db);
        try {
          put(db, "execution", id, init.record);
          putInvocation(db, init.root);
          finishWrite(db, "COMMIT;");
        } catch (error) {
          finishWrite(db, "ROLLBACK;");
          throw error;
        }
      }
      await atomic(paths.executionStorageAuthority(id), {
        schemaVersion: "pragma.execution-storage/v1",
        engine: "sqlite",
        executionId: id,
      });
      await rm(paths.executionStorageInitialization(id), { force: true });
      return true;
    });
  // Preserve the actual historical bytes before domain migrations change them.
  await withFileLock(paths.executionLock(id), async () => {
    if (json(paths.executionStorageAuthority(id)) !== undefined) return;
    const journal = json(paths.executionStorageConversion(id));
    if (journal !== undefined) {
      const backupDirectory = paths.executionStorageBackup(id);
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      const originalJournal = join(backupDirectory, "conversion-original.json");
      if (!existsSync(originalJournal))
        await durableBackup(paths.executionStorageConversion(id), originalJournal);
    }
    if (journal !== undefined && journalSchema.parse(journal).executionId !== id)
      throw new Error("Execution conversion owner mismatch.");
    if (!existsSync(paths.executionState(id))) return;
    if (journal === undefined)
      await atomic(paths.executionStorageConversion(id), {
        schemaVersion: "pragma.execution-storage-conversion/v2",
        phase: "backup",
        importedEvents: 0,
        executionId: id,
      });
    const backup = paths.executionStorageBackup(id);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    for (const file of [
      paths.executionState(id),
      paths.executionInvocations(id),
      paths.executionAgents(id),
      paths.executionContexts(id),
      paths.executionCommits(id),
      paths.executionEvents(id),
      paths.executionArchive(id),
      paths.executionTransaction(id),
    ]) {
      if (existsSync(file) && !existsSync(join(backup, basename(file))))
        await durableBackup(file, join(backup, basename(file)));
    }
  });
  // A competing process may have completed conversion while this worker waited.
  if (json(paths.executionStorageAuthority(id)) !== undefined) return await prepare(id);
  // Historical transaction migrations run under their own owner lock.
  await recoverLegacyExecutionOwner(paths, id);
  if (!existsSync(paths.executionState(id))) return false;
  return await withFileLock(paths.executionLock(id), async () => {
    if (json(paths.executionStorageAuthority(id)) !== undefined) return true;
    const journal = json(paths.executionStorageConversion(id));
    if (journal !== undefined) {
      const backupDirectory = paths.executionStorageBackup(id);
      await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
      const originalJournal = join(backupDirectory, "conversion-original.json");
      if (!existsSync(originalJournal))
        await durableBackup(paths.executionStorageConversion(id), originalJournal);
    }
    if (journal !== undefined && journalSchema.parse(journal).executionId !== id)
      throw new Error("Execution conversion owner mismatch.");
    if (journal === undefined)
      await atomic(paths.executionStorageConversion(id), {
        schemaVersion: "pragma.execution-storage-conversion/v2",
        phase: "backup",
        importedEvents: 0,
        executionId: id,
      });
    const backup = paths.executionStorageBackup(id);
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const files = [
      paths.executionState(id),
      paths.executionInvocations(id),
      paths.executionAgents(id),
      paths.executionContexts(id),
      paths.executionCommits(id),
      paths.executionEvents(id),
      paths.executionArchive(id),
    ];
    for (const file of files)
      if (existsSync(file) && !existsSync(join(backup, basename(file))))
        await durableBackup(file, join(backup, basename(file)));
    const current = ExecutionRecordSchema.parse(json(paths.executionState(id)));
    const invocations = InvocationSchema.array().parse(json(paths.executionInvocations(id)) ?? []);
    const agents = AgentInstanceSchema.array().parse(json(paths.executionAgents(id)) ?? []);
    const contexts = RuntimeContextRecordSchema.array().parse(
      json(paths.executionContexts(id)) ?? [],
    );
    const receipts = receiptsSchema.parse(json(paths.executionCommits(id)) ?? []);
    const eventFiles = [paths.executionArchive(id), paths.executionEvents(id)];
    if (current.lastAppliedSequence > 0 && !eventFiles.some((file) => existsSync(file)))
      throw new Error("Execution history is unavailable during conversion.");
    rules.assertAgentContextBindings(agents, contexts, invocations);
    rules.assertExpertTurnRootPrompt(current, invocations);
    const handoffs: { file: string; events: CanonicalEventEnvelope[] }[] = [];
    const prefix = `${encodePragmaPathSegment(id)}.`;
    let names: string[] = [];
    try {
      names = await readdir(paths.canonicalEventHandoffsRoot());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const name of names.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))) {
      const file = join(paths.canonicalEventHandoffsRoot(), name);
      const handoff = z
        .object({
          schemaVersion: z.literal("pragma.canonical-event-handoff/v1"),
          executionId: z.literal(id),
          events: z.array(CanonicalEventEnvelopeSchema),
        })
        .parse(json(file));
      handoffs.push({ file, events: handoff.events });
    }
    const sourceHash = createHash("sha256");
    for (const file of [...files, ...handoffs.map((handoff) => handoff.file)]) {
      if (!existsSync(file)) continue;
      sourceHash.update(basename(file));
      for await (const chunk of createReadStream(file)) sourceHash.update(chunk as Buffer);
    }
    const sourceFingerprint = sourceHash.digest("hex");
    const priorJournal = journal === undefined ? undefined : journalSchema.parse(journal);
    const temporary = `${paths.executionDatabase(id)}.converting`;
    const publish = async (ready: string) => {
      if (handoffs.length > 0) await registerPending(id);
      if (ready !== paths.executionDatabase(id)) await rename(ready, paths.executionDatabase(id));
      await atomic(paths.executionStorageAuthority(id), {
        schemaVersion: "pragma.execution-storage/v1",
        engine: "sqlite",
        executionId: id,
      });
      for (const handoff of handoffs) await rm(handoff.file, { force: true });
      await rm(paths.executionStorageConversion(id), { force: true });
      return true;
    };
    if (priorJournal?.phase === "publish" && priorJournal.sourceFingerprint === sourceFingerprint) {
      const ready = existsSync(temporary) ? temporary : paths.executionDatabase(id);
      if (!existsSync(ready))
        throw new Error("Converted Execution publication database is missing.");
      const completed = new DatabaseSync(ready);
      try {
        const version = (completed.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version;
        const record = read<ExecutionRecord>(completed, "execution", id);
        if (version !== 1 || JSON.stringify(record) !== JSON.stringify(current))
          throw new Error("Converted Execution publication metadata mismatch.");
        for (const [table, count] of [
          ["invocations", invocations.length],
          ["agents", agents.length],
          ["contexts", contexts.length],
          ["events", current.lastAppliedSequence],
          ["receipts", receipts.length],
        ] as const) {
          const row = completed.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count: number;
          };
          if (row.count !== count)
            throw new Error("Converted Execution publication count mismatch.");
        }
        for (const receipt of receipts) {
          const row = completed
            .prepare("SELECT signature FROM receipts WHERE id=?")
            .get(receipt.commitId) as { signature: string } | undefined;
          if (row?.signature !== receipt.signature)
            throw new Error("Converted Execution publication receipt mismatch.");
        }
        const pending = new Map(
          handoffs.flatMap((handoff) =>
            handoff.events.map((event) => [event.eventId, JSON.stringify(event)] as const),
          ),
        );
        const rows = completed.prepare("SELECT id,payload FROM outbox").all() as {
          id: string;
          payload: string;
        }[];
        if (rows.length !== pending.size || rows.some((row) => pending.get(row.id) !== row.payload))
          throw new Error("Converted Execution publication outbox mismatch.");
        const integrity = completed.prepare("PRAGMA quick_check").get() as { quick_check: string };
        if (integrity.quick_check !== "ok")
          throw new Error("Converted Execution publication integrity check failed.");
      } finally {
        completed.close();
      }
      return await publish(ready);
    }
    const resume =
      priorJournal?.sourceFingerprint === sourceFingerprint &&
      priorJournal.phase === "import" &&
      existsSync(temporary);
    if (!resume)
      for (const suffix of ["", "-wal", "-shm"]) await rm(`${temporary}${suffix}`, { force: true });
    await atomic(paths.executionStorageConversion(id), {
      schemaVersion: "pragma.execution-storage-conversion/v2",
      executionId: id,
      phase: "import",
      sourceFingerprint,
      importedEvents: resume ? priorJournal.importedEvents : 0,
    });
    const db = new DatabaseSync(temporary);
    try {
      initialize(db);
      await beginWrite(db);
      put(db, "execution", id, current);
      for (const invocation of invocations) putInvocation(db, invocation);
      for (const agent of agents) putAgent(db, agent);
      for (const context of contexts) put(db, "contexts", context.contextId, context);
      const eventInsert = db.prepare("INSERT OR IGNORE INTO events VALUES(?,?,?)");
      const eventById = db.prepare("SELECT payload FROM events WHERE id=?");
      let imported = (db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number })
        .count;
      let processedEvents = 0;
      let batchBytes = 0;
      let batchEvents = 0;
      for (const file of eventFiles) {
        if (!existsSync(file)) continue;
        const stream = createReadStream(file);
        const contents = file.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
        const lines = createInterface({ input: contents, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (line.trim() === "") continue;
            const event = ExecutionEventSchema.parse(JSON.parse(line));
            if (event.executionId !== id) throw new Error("Execution event owner mismatch.");
            const payload = JSON.stringify(event);
            const existing = eventById.get(event.eventId) as { payload: string } | undefined;
            if (existing !== undefined && existing.payload !== payload)
              throw new Error("Execution conversion event identity conflict.");
            const inserted = eventInsert.run(event.cursor.sequence, event.eventId, payload);
            if (Number(inserted.changes) === 0 && existing === undefined)
              throw new Error("Execution conversion event sequence conflict.");
            if (Number(inserted.changes) > 0) {
              imported++;
              batchEvents++;
              batchBytes += Buffer.byteLength(payload);
            }
            if (batchEvents >= 4096 || batchBytes >= 1024 * 1024) {
              finishWrite(db, "COMMIT;");
              await atomic(paths.executionStorageConversion(id), {
                schemaVersion: "pragma.execution-storage-conversion/v2",
                executionId: id,
                phase: "import",
                sourceFingerprint,
                importedEvents: imported,
              });
              await beginWrite(db);
              batchEvents = 0;
              batchBytes = 0;
            }
            processedEvents++;
            if (processedEvents % 256 === 0)
              await new Promise<void>((resolve) => setImmediate(resolve));
          }
        } finally {
          lines.close();
          contents.destroy();
          stream.destroy();
        }
      }
      const lastEvent = db.prepare("SELECT MAX(sequence) AS sequence FROM events").get() as {
        sequence: number | null;
      };
      if (
        (lastEvent.sequence ?? 0) !== current.lastAppliedSequence ||
        imported !== current.lastAppliedSequence
      )
        throw new Error("Execution conversion cursor mismatch.");
      const receiptInsert = db.prepare("INSERT OR IGNORE INTO receipts VALUES(?,?,?)");
      for (const receipt of receipts) {
        const receiptEvents = receipt.eventIds.map((eventId) => {
          const row = eventById.get(eventId) as { payload: string } | undefined;
          if (row === undefined) throw new Error("Execution conversion receipt event is missing.");
          return JSON.parse(row.payload) as unknown;
        });
        const priorReceipt = db
          .prepare("SELECT signature FROM receipts WHERE id=?")
          .get(receipt.commitId) as { signature: string } | undefined;
        if (priorReceipt !== undefined && priorReceipt.signature !== receipt.signature)
          throw new Error("Execution conversion receipt identity conflict.");
        receiptInsert.run(
          receipt.commitId,
          receipt.signature,
          JSON.stringify({
            execution: { ...current, version: receipt.committedVersion },
            invocations: [],
            agents: [],
            contexts: [],
            events: receiptEvents,
          }),
        );
      }
      for (const handoff of handoffs) for (const event of handoff.events) insertOutbox(db, event);
      finishWrite(db, "COMMIT;");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      for (const [table, count] of [
        ["invocations", invocations.length],
        ["agents", agents.length],
        ["contexts", contexts.length],
        ["events", imported],
      ] as const) {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        if (row.count !== count) throw new Error("Execution conversion row count mismatch.");
      }
    } finally {
      db.close();
    }
    await atomic(paths.executionStorageConversion(id), {
      schemaVersion: "pragma.execution-storage-conversion/v2",
      executionId: id,
      phase: "publish",
      sourceFingerprint,
      importedEvents: current.lastAppliedSequence,
      handoffNames: handoffs.map((value) => basename(value.file)),
    });
    return await publish(temporary);
  });
}

async function commit(
  db: DatabaseSync,
  request: ExecutionCommitRequest,
  canonical: boolean,
): Promise<ExecutionCommitResult & { publishedEvents: ExecutionEvent[] }> {
  const signature = rules.commitSignature(request);
  if (request.commitId.trim() === "") throw new Error("Execution commitId must not be empty.");
  await beginWrite(db);
  try {
    const receipt = db
      .prepare("SELECT signature,payload FROM receipts WHERE id=?")
      .get(request.commitId) as { signature: string; payload: string } | undefined;
    if (receipt !== undefined) {
      if (receipt.signature !== signature)
        throw new Error(`Execution commit idempotency conflict: ${request.commitId}`);
      const result = JSON.parse(receipt.payload) as ExecutionCommitResult;
      finishWrite(db, "COMMIT;");
      return {
        ...result,
        execution: read<ExecutionRecord>(db, "execution", request.executionId)!,
        publishedEvents: [],
      };
    }
    const current = ExecutionRecordSchema.parse(read(db, "execution", request.executionId));
    if (request.expectedVersion !== undefined && request.expectedVersion !== current.version)
      throw new ExecutionVersionConflictError(request.expectedVersion, current.version);
    if (canonical && (request.events?.length ?? 0) > 0) await registerPending(request.executionId);
    const invocations = new Map<string, Invocation>();
    const agents = new Map<string, AgentInstance>();
    const contexts = new Map<string, RuntimeContextRecord>();
    const loadedInvocations = new Set<string>();
    const loadedAgents = new Set<string>();
    const loadInvocation = (id: string) => {
      if (loadedInvocations.has(id)) return;
      loadedInvocations.add(id);
      const value = read<Invocation>(db, "invocations", id);
      if (value) invocations.set(id, value);
    };
    const loadAgent = (id: string) => {
      if (loadedAgents.has(id)) return;
      loadedAgents.add(id);
      const value = read<AgentInstance>(db, "agents", id);
      if (value) agents.set(id, value);
    };
    loadInvocation(current.rootInvocationId);
    for (const event of request.events ?? []) loadInvocation(event.invocationId);
    for (const value of request.invocationPuts ?? []) loadInvocation(value.invocationId);
    for (const value of request.invocationPatches ?? []) loadInvocation(value.invocationId);
    for (const value of request.agentPuts ?? []) loadAgent(value.agentId);
    for (const value of request.agentPatches ?? []) loadAgent(value.agentId);
    for (const value of request.contextPuts ?? []) {
      const found = read<RuntimeContextRecord>(db, "contexts", value.contextId);
      if (found) contexts.set(value.contextId, found);
    }
    for (const value of request.contextPatches ?? []) {
      const found = read<RuntimeContextRecord>(db, "contexts", value.contextId);
      if (found) contexts.set(value.contextId, found);
    }
    // Include existing agents bound to touched contexts and invocations.
    for (const id of new Set([
      ...invocations.keys(),
      ...(request.invocationPuts ?? []).map((value) => value.invocationId),
    ])) {
      for (const row of db
        .prepare("SELECT payload FROM agents WHERE active_invocation_id=?")
        .all(id) as { payload: string }[]) {
        const value = JSON.parse(row.payload) as AgentInstance;
        agents.set(value.agentId, value);
      }
    }
    for (const id of new Set([
      ...contexts.keys(),
      ...(request.contextPuts ?? []).map((value) => value.contextId),
    ])) {
      for (const row of db.prepare("SELECT payload FROM agents WHERE context_id=?").all(id) as {
        payload: string;
      }[]) {
        const value = JSON.parse(row.payload) as AgentInstance;
        agents.set(value.agentId, value);
      }
    }
    for (const patch of request.agentPatches ?? [])
      if (patch.patch.activeInvocationId !== undefined)
        loadInvocation(patch.patch.activeInvocationId);
    for (const agent of [...agents.values(), ...(request.agentPuts ?? [])])
      if (agent.activeInvocationId !== undefined) loadInvocation(agent.activeInvocationId);
    const now = new Date().toISOString();
    rules.assertFinalStatusTransitions(
      current,
      [...invocations.values()],
      request,
      rules.hasActiveRecoveryClaim(current, request.recoveryClaimId),
    );
    const nextInvocations = rules.applyInvocationChanges(
      [...invocations.values()],
      request.invocationPuts ?? [],
      request.invocationPatches ?? [],
      now,
    );
    const nextAgents = rules.applyAgentChanges(
      [...agents.values()],
      request.agentPuts ?? [],
      request.agentPatches ?? [],
      now,
    );
    for (const agent of nextAgents) {
      const value = read<RuntimeContextRecord>(db, "contexts", agent.contextId);
      if (value) contexts.set(value.contextId, value);
    }
    for (const invocation of nextInvocations) {
      const value = read<RuntimeContextRecord>(db, "contexts", invocation.contextId);
      if (value) contexts.set(value.contextId, value);
    }
    const nextContexts = rules.applyContextChanges(
      [...contexts.values()],
      request.contextPuts ?? [],
      request.contextPatches ?? [],
      now,
    );
    rules.assertAgentContextBindings(nextAgents, nextContexts, nextInvocations);
    const existingEvents = (request.events ?? []).flatMap((event) =>
      event.eventId === undefined
        ? []
        : (() => {
            const value = read<ExecutionEvent>(db, "events", event.eventId);
            return value ? [value] : [];
          })(),
    );
    const materialized = rules.materializeEvents(
      request.executionId,
      existingEvents,
      request.events ?? [],
      now,
      current.lastAppliedSequence,
    );
    const execution = ExecutionRecordSchema.parse({
      ...current,
      ...request.executionPatch,
      executionId: current.executionId,
      version: current.version + 1,
      lastAppliedSequence:
        materialized.newEvents.at(-1)?.cursor.sequence ?? current.lastAppliedSequence,
      updatedAt: now,
    });
    rules.assertExpertTurnRootPrompt(execution, nextInvocations);
    const invocationIds = new Set([
      ...(request.invocationPuts ?? []).map((value) => value.invocationId),
      ...(request.invocationPatches ?? []).map((value) => value.invocationId),
    ]);
    const agentIds = new Set([
      ...(request.agentPuts ?? []).map((value) => value.agentId),
      ...(request.agentPatches ?? []).map((value) => value.agentId),
    ]);
    const contextIds = new Set([
      ...(request.contextPuts ?? []).map((value) => value.contextId),
      ...(request.contextPatches ?? []).map((value) => value.contextId),
    ]);
    const changedInvocations = nextInvocations.filter((value) =>
      invocationIds.has(value.invocationId),
    );
    const changedAgents = nextAgents.filter((value) => agentIds.has(value.agentId));
    const changedContexts = nextContexts.filter((value) => contextIds.has(value.contextId));
    put(db, "execution", execution.executionId, execution);
    for (const value of changedInvocations) putInvocation(db, value);
    for (const value of changedAgents) putAgent(db, value);
    for (const value of changedContexts) put(db, "contexts", value.contextId, value);
    for (const event of materialized.newEvents) {
      insertEvent(db, event);
      if (canonical) {
        const invocation =
          nextInvocations.find((value) => value.invocationId === event.invocationId) ??
          read<Invocation>(db, "invocations", event.invocationId);
        const context =
          invocation === undefined
            ? undefined
            : read<RuntimeContextRecord>(db, "contexts", invocation.contextId);
        insertOutbox(
          db,
          rules.toCanonicalExecutionEvent(event, {
            schemaVersion: "pragma.execution-transaction/v13",
            commitId: request.commitId,
            signature,
            execution,
            invocations: invocation === undefined ? [] : [invocation],
            contexts: context === undefined ? [] : [context],
            agents: [],
            events: [],
            eventIds: [],
          }),
        );
      }
    }
    const result = {
      execution,
      invocations: changedInvocations,
      agents: changedAgents,
      contexts: changedContexts,
      events: materialized.requestedEvents,
    };
    db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(
      request.commitId,
      signature,
      JSON.stringify(result),
    );
    finishWrite(db, "COMMIT;");
    return { ...result, publishedEvents: materialized.newEvents };
  } catch (error) {
    finishWrite(db, "ROLLBACK;");
    throw error;
  }
}

interface Request {
  requestId: number;
  operation: string;
  executionId: string;
  input?: unknown;
  canonical?: boolean;
  pragmaHome?: string;
}
const usageDatabases = new Map<
  string,
  { store: DesktopUsageStore; updates: UsageUpdate[]; references: number }
>();
async function executeUsage(request: Request): Promise<unknown> {
  const key = request.executionId;
  if (request.operation === "usage:open") {
    let current = usageDatabases.get(key);
    if (current === undefined) {
      const store = await openUsageDatabase(
        request.input as Parameters<typeof openUsageDatabase>[0],
      );
      current = { store, updates: [], references: 0 };
      const updates = current.updates;
      store.subscribe((update) => updates.push(update));
      usageDatabases.set(key, current);
    }
    current.references++;
    return current.store.trackingStartedAt;
  }
  const current = usageDatabases.get(key);
  if (current === undefined)
    throw Object.assign(new Error("Usage database is not initialized."), {
      code: "USAGE_DATABASE_NOT_INITIALIZED",
    });
  const args = (request.input ?? []) as unknown[];
  let value: unknown;
  const store = current.store;
  switch (request.operation) {
    case "usage:record":
      value = store.record(...(args as Parameters<typeof store.record>));
      break;
    case "usage:recordRecovered":
      value = store.recordRecovered(...(args as Parameters<typeof store.recordRecovered>));
      break;
    case "usage:getOverview":
      value = store.getOverview(...(args as Parameters<typeof store.getOverview>));
      break;
    case "usage:listSubjects":
      value = store.listSubjects(...(args as Parameters<typeof store.listSubjects>));
      break;
    case "usage:getMissionUsage":
      value = store.getMissionUsage(...(args as Parameters<typeof store.getMissionUsage>));
      break;
    case "usage:markSubjectDeleted":
      value = store.markSubjectDeleted(...(args as Parameters<typeof store.markSubjectDeleted>));
      break;
    case "usage:reconcileActiveSubjects":
      value = store.reconcileActiveSubjects(
        ...(args as Parameters<typeof store.reconcileActiveSubjects>),
      );
      break;
    case "usage:assertAvailable":
      value = store.assertAvailable();
      break;
    case "usage:close":
      if (--current.references === 0) {
        store.close();
        usageDatabases.delete(key);
      }
      break;
    default:
      throw new Error("Unsupported usage operation.");
  }
  return { value, updates: current.updates.splice(0) };
}
async function execute(request: Request): Promise<unknown> {
  if (request.operation === "benchmark-metrics") {
    if (!benchmarkEnabled) throw new Error("Storage benchmark instrumentation is disabled.");
    const result = benchmarkMetrics;
    benchmarkMetrics = {
      writes: 0,
      lockWaitMs: 0,
      maxLockWaitMs: 0,
      writeLockHeldMs: 0,
      maxWriteLockHeldMs: 0,
      requests: 0,
      queueWaitMs: 0,
      maxQueueWaitMs: 0,
    };
    return result;
  }
  if (request.operation.startsWith("usage-ledger:"))
    return await executeUsageLedger(
      request.executionId,
      request.operation.slice(13),
      request.input,
    );
  if (request.operation.startsWith("usage-receipt:"))
    return await executeUsageReceipt(
      request.executionId,
      request.operation.slice(14),
      request.input,
    );
  if (request.operation.startsWith("mission-receipt:")) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await executeMissionReceipt(
          request.executionId,
          request.operation.slice(16),
          request.input as unknown[],
        );
      } catch (error) {
        if (!String((error as Error).message).includes("database is locked") || attempt >= 5)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  }
  if (request.operation.startsWith("usage:")) return await executeUsage(request);
  paths = new PragmaPaths({ pragmaHome: request.pragmaHome });
  const id = request.executionId;
  if (request.operation === "close") {
    for (const key of databases.keys()) close(key);
    return;
  }
  if (request.operation === "close-owner") {
    close(id);
    return;
  }
  if (
    request.operation === "ack" &&
    (request.input as string[]).length === 0 &&
    !existsSync(paths.executionCanonicalPending(id))
  )
    return false;
  if (request.operation === "prepare-owner") return await prepare(id);
  const marker = json(paths.executionStorageAuthority(id));
  if (marker !== undefined) {
    const parsed = authoritySchema.parse(marker);
    if (parsed.executionId !== id || !existsSync(paths.executionDatabase(id)))
      throw new Error("Execution storage authority is incomplete.");
  }
  const preparationRequired =
    existsSync(paths.executionStorageConversion(id)) ||
    existsSync(paths.executionStorageInitialization(id)) ||
    (marker === undefined && existsSync(paths.executionState(id)));
  if (request.operation === "get-prepared") {
    if (preparationRequired) return { state: "requires_preparation" };
    if (marker === undefined) return { state: "ready" };
    try {
      return { state: "ready", execution: read(database(id), "execution", id) };
    } finally {
      close(id);
    }
  }
  if (preparationRequired)
    throw Object.assign(new Error("Execution owner requires preparation."), {
      code: "EXECUTION_OWNER_PREPARATION_REQUIRED",
    });
  const prepared = marker !== undefined;
  const action = async () => {
    if (!prepared && request.operation !== "create") {
      close(id);
      if (["commit", "ack", "archive"].includes(request.operation))
        throw new Error(`Execution not found: ${id}`);
      return undefined;
    }
    if (request.operation === "create") {
      if (prepared || json(paths.executionStorageAuthority(id)) !== undefined)
        throw new Error(`Execution already exists: ${id}`);
      await mkdir(paths.executionRoot(id), { recursive: true, mode: 0o700 });
      const { record, root } = request.input as { record: ExecutionRecord; root: Invocation };
      const execution = ExecutionRecordSchema.parse(record);
      const invocation = InvocationSchema.parse(root);
      if (execution.executionId !== id || execution.rootInvocationId !== invocation.invocationId)
        throw new Error("Execution root identity mismatch.");
      rules.assertExpertTurnRootPrompt(execution, [invocation]);
      await atomic(paths.executionStorageInitialization(id), {
        schemaVersion: "pragma.execution-storage-initialization/v1",
        executionId: id,
        record: execution,
        root: invocation,
      });
      const db = database(id, true);
      await beginWrite(db);
      try {
        put(db, "execution", id, execution);
        putInvocation(db, invocation);
        finishWrite(db, "COMMIT;");
      } catch (error) {
        finishWrite(db, "ROLLBACK;");
        throw error;
      }
      await atomic(paths.executionStorageAuthority(id), {
        schemaVersion: "pragma.execution-storage/v1",
        engine: "sqlite",
        executionId: id,
      });
      await rm(paths.executionStorageInitialization(id), { force: true });
      return;
    }
    const db = database(id);
    switch (request.operation) {
      case "get":
        return read(db, "execution", id);
      case "get-invocation":
        return read(db, "invocations", request.input as string);
      case "get-agent":
        return read(db, "agents", request.input as string);
      case "get-context":
        return read(db, "contexts", request.input as string);
      case "list-invocations":
        return list(db, "invocations");
      case "list-agents":
        return list(db, "agents");
      case "list-contexts":
        return list(db, "contexts");
      case "tree":
        return readSnapshot(db, () =>
          rules.buildTree(
            read<ExecutionRecord>(db, "execution", id)!.rootInvocationId,
            list(db, "invocations"),
          ),
        );
      case "events": {
        const input = request.input as {
          after?: { executionId: string; sequence: number };
          limit?: number;
        };
        if (input.after !== undefined && input.after.executionId !== id)
          throw new Error("Execution cursor owner mismatch.");
        if (
          input.limit !== undefined &&
          (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10000)
        )
          throw new Error("Invalid Execution page size.");
        return (
          db
            .prepare("SELECT payload FROM events WHERE sequence>? ORDER BY sequence LIMIT ?")
            .all(input.after?.sequence ?? 0, input.limit ?? -1) as { payload: string }[]
        ).map((row) => ExecutionEventSchema.parse(JSON.parse(row.payload)));
      }
      case "commit": {
        return commit(db, request.input as ExecutionCommitRequest, request.canonical ?? false);
      }
      case "outbox":
        return (
          db.prepare("SELECT payload FROM outbox ORDER BY sequence LIMIT 64").all() as {
            payload: string;
          }[]
        ).map((row) => JSON.parse(row.payload) as unknown);
      case "ack": {
        const eventIds = request.input as string[];
        if (eventIds.length > 0) {
          await beginWrite(db);
          try {
            const remove = db.prepare("DELETE FROM outbox WHERE id=?");
            for (const eventId of eventIds) remove.run(eventId);
            finishWrite(db, "COMMIT;");
          } catch (error) {
            finishWrite(db, "ROLLBACK;");
            throw error;
          }
        }
        // The caller holds the canonical delivery/deletion fence. Serialize marker
        // retirement with foreground source registration using SQLite's writer lock.
        // Recheck after the durable delete so another process's commit cannot lose
        // its registration between the delete and this cleanup transaction.
        await beginWrite(db);
        try {
          const pending = db.prepare("SELECT 1 FROM outbox LIMIT 1").get() !== undefined;
          if (!pending && existsSync(paths.executionCanonicalPending(id))) {
            await rename(
              paths.executionCanonicalPending(id),
              paths.executionCanonicalIdleRegistration(id),
            );
          }
          finishWrite(db, "COMMIT;");
          return pending;
        } catch (error) {
          finishWrite(db, "ROLLBACK;");
          throw error;
        }
      }
      case "archive":
        if (!isTerminalExecutionStatus(read<ExecutionRecord>(db, "execution", id)!.status))
          throw new Error(`Cannot archive a non-terminal Execution: ${id}.`);
        // SQLite history already shares the indexed authority. Materialize
        // committed WAL pages without creating another JSON history authority.
        db.exec("PRAGMA wal_checkpoint(PASSIVE);");
        return;
      case "export":
        return readSnapshot(db, () => ({
          schemaVersion: "pragma.execution-storage-export/v1",
          execution: read(db, "execution", id),
          invocations: list(db, "invocations"),
          agents: list(db, "agents"),
          contexts: list(db, "contexts"),
          events: list(db, "events"),
          commits: (
            db.prepare("SELECT id,signature,payload FROM receipts ORDER BY rowid").all() as {
              id: string;
              signature: string;
              payload: string;
            }[]
          ).map((row) => {
            const receipt = JSON.parse(row.payload) as ExecutionCommitResult;
            return {
              commitId: row.id,
              signature: row.signature,
              committedVersion: receipt.execution.version,
              eventIds: receipt.events.map((event) => event.eventId),
            };
          }),
          pendingCanonicalEvents: list(db, "outbox"),
        }));
      default:
        throw new Error(`Unknown Execution operation: ${request.operation}`);
    }
  };
  try {
    if (["create", "commit", "archive"].includes(request.operation))
      return await withFileLock(paths.executionLock(id), action, {
        operation: `execution.sqlite.${request.operation}`,
      });
    return await action();
  } finally {
    close(id);
  }
}
const requests: Request[] = [];
let processing = false;
let foregroundBatch = 0;
const background = (request: Request) =>
  [
    "outbox",
    "ack",
    "archive",
    "prepare-owner",
    "mission-receipt:stagePage",
    "mission-receipt:inspect",
  ].includes(request.operation) || request.operation.startsWith("usage");
async function processNext(): Promise<void> {
  const owners = new Set<string>();
  let foregroundIndex = -1;
  let backgroundIndex = -1;
  for (let position = 0; position < requests.length; position++) {
    const item = requests[position]!;
    const owner = JSON.stringify([item.pragmaHome, item.executionId]);
    if (owners.has(owner)) continue;
    owners.add(owner);
    if (background(item)) {
      if (backgroundIndex < 0) backgroundIndex = position;
    } else if (foregroundIndex < 0) foregroundIndex = position;
    if (foregroundIndex >= 0 && backgroundIndex >= 0) break;
  }
  const index =
    foregroundBatch >= 8 && backgroundIndex >= 0
      ? backgroundIndex
      : foregroundIndex >= 0
        ? foregroundIndex
        : 0;
  const request = requests.splice(index, 1)[0];
  if (request === undefined) {
    processing = false;
    return;
  }
  foregroundBatch = background(request) ? 0 : foregroundBatch + 1;
  if (benchmarkEnabled && request.operation !== "benchmark-metrics") {
    const queued = performance.now() - (requestStarts.get(request) ?? performance.now());
    benchmarkMetrics.requests++;
    benchmarkMetrics.queueWaitMs += queued;
    benchmarkMetrics.maxQueueWaitMs = Math.max(benchmarkMetrics.maxQueueWaitMs, queued);
    requestStarts.delete(request);
  }
  try {
    port.postMessage({ requestId: request.requestId, ok: true, value: await execute(request) });
  } catch (error) {
    const failure = error as Error & { code?: unknown };
    port.postMessage({
      requestId: request.requestId,
      ok: false,
      error: {
        name: failure.name,
        message: failure.message,
        code: failure.code,
        stack: benchmarkEnabled ? failure.stack : undefined,
      },
    });
  } finally {
    close(request.executionId);
  }
  setImmediate(() => {
    void processNext();
  });
}
port.on("message", (request: Request) => {
  if (benchmarkEnabled) requestStarts.set(request, performance.now());
  requests.push(request);
  if (!processing) {
    processing = true;
    void processNext();
  }
});
