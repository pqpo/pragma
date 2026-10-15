import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths, withFileLock } from "@pragma/core";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../../storage/memory-storage-policy.ts";
import {
  State,
  Provenance,
  MemoryExtractionToolSchemas,
  MEMORY_EXTRACTION_LIMITS,
  fail,
  type SessionState,
  type MemoryExtractionInput,
  type MemoryExtractionSession,
  type MemoryExtractionReceipt,
  type MemoryExtractionSessionGuard,
  type MemoryExtractionToolName,
} from "./schema.ts";
import { renderTask, markInlineRead } from "./evidence.ts";
import { callTool } from "./tools.ts";
function keyFor(module: string, jobId: string, watermark: string): string {
  return createHash("sha256")
    .update(JSON.stringify([module, jobId, watermark]))
    .digest("hex");
}

function assertSnapshotScope(state: SessionState, input: MemoryExtractionInput): void {
  if (
    JSON.stringify(state.input.evidence) !== JSON.stringify(input.evidence) ||
    ("allowedSubjectRefs" in state.input &&
      JSON.stringify(state.input.allowedSubjectRefs) !==
        JSON.stringify("allowedSubjectRefs" in input ? input.allowedSubjectRefs : []))
  ) {
    fail("memory_curator_snapshot_scope_changed");
  }
}

/** Read-only proof for the synchronous job claim transaction; never creates state or admits a model. */
export function hasMemoryExtractionReceipt(
  options: { pragmaHome?: string | undefined },
  module: "episodic" | "semantic",
  jobId: string,
  watermark: string,
): boolean {
  const path = new PragmaPaths(options).memoryExtractionSessions();
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    if (
      version === 0 &&
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get() === undefined
    )
      return false;
    if (version !== 1) fail("memory_curator_session_version_unsupported");
    const row = db
      .prepare("SELECT state_json FROM sessions WHERE key = ?")
      .get(keyFor(module, jobId, watermark)) as { state_json: string } | undefined;
    if (row === undefined) return false;
    const state = State.parse(JSON.parse(row.state_json));
    return state.output !== undefined && state.provenance !== undefined;
  } finally {
    db.close();
  }
}

/** One SQLite transaction contains each snapshot, candidate update, receipt and Mission attachment. */
export function createMemoryExtractionSessionStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
) {
  const path = new PragmaPaths(options).memoryExtractionSessions();
  const now = options.now ?? (() => new Date());
  async function transaction<T>(operation: (db: DatabaseSync) => Promise<T> | T): Promise<T> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return await withFileLock(`${path}.lock`, async () => {
      const db = new DatabaseSync(path);
      try {
        const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
          .user_version;
        if (version === 0) {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get())
            fail("memory_curator_session_version_invalid");
          db.exec(
            "BEGIN IMMEDIATE; CREATE TABLE sessions (key TEXT PRIMARY KEY, module TEXT NOT NULL, job_id TEXT NOT NULL, updated_at TEXT NOT NULL, state_json TEXT NOT NULL); CREATE TABLE missions (mission_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE); PRAGMA user_version = 1; COMMIT;",
          );
        } else if (version !== 1) fail("memory_curator_session_version_unsupported");
        db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
        const result = await operation(db);
        db.exec("COMMIT;");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK;");
        throw error;
      } finally {
        db.close();
      }
    });
  }
  function read(db: DatabaseSync, key: string): SessionState | undefined {
    const row = db.prepare("SELECT state_json FROM sessions WHERE key = ?").get(key) as
      { state_json: string } | undefined;
    return row === undefined ? undefined : State.parse(JSON.parse(row.state_json));
  }
  function save(db: DatabaseSync, state: SessionState): void {
    const value = JSON.stringify(State.parse(state));
    if (
      Buffer.byteLength(value) >
      DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxBytesPerExecution + 1_000_000
    )
      fail("memory_curator_session_capacity");
    db.prepare(
      "INSERT INTO sessions(key, module, job_id, updated_at, state_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at, state_json = excluded.state_json",
    ).run(state.key, state.module, state.jobId, state.updatedAt, value);
  }
  async function guardCurrent(guard: MemoryExtractionSessionGuard): Promise<void> {
    guard.signal?.throwIfAborted();
    await guard.assertAccess?.();
    if (guard.isCurrent !== undefined && !(await guard.isCurrent()))
      fail("memory_curator_claim_stale");
  }
  function session(
    initial: SessionState,
    guard: MemoryExtractionSessionGuard,
  ): MemoryExtractionSession {
    const toolNames: MemoryExtractionToolName[] = [
      "list_evidence",
      "read_evidence",
      "find_existing_memory",
      initial.module === "semantic" ? "submit_fact" : "submit_episode_part",
      "finish_extraction",
    ];
    return {
      key: initial.key,
      module: initial.module,
      toolNames,
      prompt: () => renderTask(initial),
      async bindMission(missionId) {
        await transaction((db) => {
          db.prepare("INSERT INTO missions(mission_id, session_key) VALUES (?, ?)").run(
            missionId,
            initial.key,
          );
        });
      },
      async setProvenance(value) {
        await transaction((db) => {
          const state = read(db, initial.key)!;
          state.provenance = Provenance.parse(value);
          save(db, state);
        });
      },
      async failure() {
        return await transaction((db) => read(db, initial.key)?.lastError);
      },
      async setContextBudget(tokens) {
        await transaction((db) => {
          const state = read(db, initial.key)!;
          state.tokenLimit = Math.max(1, Math.min(32000, Math.floor(tokens)));
          save(db, state);
        });
      },
      async receipt() {
        return await transaction((db) => {
          const state = read(db, initial.key)!;
          return state.output !== undefined && state.provenance !== undefined
            ? { output: state.output, provenance: state.provenance }
            : undefined;
        });
      },
      async call(name, args) {
        try {
          await guardCurrent(guard);
        } catch (error) {
          if (
            !guard.signal?.aborted &&
            (guard.isCurrent === undefined || (await guard.isCurrent()))
          ) {
            await transaction((db) => {
              const state = read(db, initial.key);
              if (state === undefined || state.output !== undefined) return;
              state.lastError =
                error instanceof Error ? error.message : "memory_curator_access_denied";
              state.updatedAt = now().toISOString();
              save(db, state);
            });
          }
          throw error;
        }
        if (!toolNames.includes(name)) fail("memory_curator_tool_unavailable");
        const outcome = await transaction(async (db) => {
          const state = read(db, initial.key)!;
          if (state.output !== undefined)
            return { text: "Extraction already finished. The durable receipt is available." };
          const before = State.parse(state);
          state.calls++;
          try {
            if (state.calls > MEMORY_EXTRACTION_LIMITS.calls && name !== "finish_extraction")
              fail("memory_curator_budget_exhausted");
            const parsed = MemoryExtractionToolSchemas[name].parse(args);
            const text = await callTool(state, name, parsed, guard);
            await guardCurrent(guard);
            delete state.lastError;
            state.updatedAt = now().toISOString();
            save(db, state);
            return { text };
          } catch (error) {
            await guardCurrent(guard);
            before.calls = state.calls;
            before.lastError =
              error instanceof Error ? error.message : "memory_curator_tool_failed";
            before.updatedAt = now().toISOString();
            save(db, before);
            return { error };
          }
        });
        if ("error" in outcome) throw outcome.error;
        return outcome.text;
      },
    };
  }
  return {
    async maintain(): Promise<void> {
      await transaction((db) => {
        db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(
          new Date(
            now().getTime() - DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs,
          ).toISOString(),
        );
      });
    },
    async create(
      input: {
        module: "episodic" | "semantic";
        input: MemoryExtractionInput;
        watermark: string;
      } & MemoryExtractionSessionGuard,
    ): Promise<MemoryExtractionSession> {
      const key = keyFor(input.module, input.input.jobId, input.watermark);
      const state = await transaction((db) => {
        db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(
          new Date(
            now().getTime() - DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs,
          ).toISOString(),
        );
        const existing = read(db, key);
        if (existing !== undefined) {
          assertSnapshotScope(existing, input.input);
          if (existing.output === undefined) {
            existing.calls = 0;
            existing.deliveredTokens = 0;
            delete existing.lastError;
            save(db, existing);
          }
          return existing;
        }
        const count = (
          db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }
        ).count;
        if (count >= DEFAULT_MEMORY_STORAGE_POLICY.curatorRegistryMaxEntries)
          fail("memory_curator_session_capacity");
        const timestamp = now().toISOString();
        const state = State.parse({
          schemaVersion: "pragma.memory-curator-session/v1",
          key,
          module: input.module,
          jobId: input.input.jobId,
          watermark: input.watermark,
          input: input.input,
          facts: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          read: {},
          calls: 0,
          deliveredTokens: 0,
          tokenLimit: 32000,
          candidates: {},
          parts: {},
        });
        markInlineRead(state);
        save(db, state);
        return state;
      });
      return session(state, input);
    },
    async forMission(
      missionId: string,
      guard: MemoryExtractionSessionGuard = {},
    ): Promise<MemoryExtractionSession | undefined> {
      const state = await transaction((db) => {
        const row = db
          .prepare("SELECT session_key FROM missions WHERE mission_id = ?")
          .get(missionId) as { session_key: string } | undefined;
        return row === undefined ? undefined : read(db, row.session_key);
      });
      return state === undefined ? undefined : session(state, guard);
    },
    async recover(
      module: "episodic" | "semantic",
      jobId: string,
      watermark: string,
      input?: MemoryExtractionInput,
    ): Promise<MemoryExtractionReceipt | undefined> {
      return await transaction((db) => {
        const state = read(db, keyFor(module, jobId, watermark));
        if (state !== undefined && input !== undefined) assertSnapshotScope(state, input);
        return state?.output !== undefined && state.provenance !== undefined
          ? { output: state.output, provenance: state.provenance }
          : undefined;
      });
    },
    async deleteJobs(module: "episodic" | "semantic", jobIds: readonly string[]): Promise<void> {
      await transaction((db) => {
        for (const id of jobIds)
          db.prepare("DELETE FROM sessions WHERE module = ? AND job_id = ?").run(module, id);
      });
    },
    async deleteExecutions(ids: readonly string[]): Promise<void> {
      await transaction((db) => {
        for (const id of ids)
          db.prepare(
            "DELETE FROM sessions WHERE key IN (SELECT s.key FROM sessions s, json_each(s.state_json, '$.input.evidence') e WHERE json_extract(e.value, '$.correlationId') = ?)",
          ).run(id);
      });
    },
  };
}
