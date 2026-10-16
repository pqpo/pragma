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
import { renderTask, markInlineRead, boundedPrefix, deliver } from "./evidence.ts";
import { callTool } from "./tools.ts";
import { CURATOR_SESSION_MIGRATIONS } from "../../storage/migrations/curator-sessions/index.ts";
import { CuratorSessionV1Schema } from "../../storage/migrations/curator-sessions/schemas/v1.ts";
import { runAdjacentSqliteMigrations } from "../../storage/sqlite-migration-backup.ts";
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

function sourceReceipt(
  db: DatabaseSync,
  module: "episodic" | "semantic",
  jobId: string,
  watermark: string,
  input?: MemoryExtractionInput,
): MemoryExtractionReceipt | undefined {
  const row = db
    .prepare(
      `SELECT state_json FROM sessions WHERE module = 'conversation' AND json_extract(state_json, '$.input.jobs.${module}.jobId') = ? AND json_extract(state_json, '$.input.jobs.${module}.watermark') = ? ORDER BY json_extract(state_json, '$.retryGeneration') DESC, rowid DESC LIMIT 1`,
    )
    .get(jobId, watermark) as { state_json: string } | undefined;
  if (row === undefined) return undefined;
  const state = State.parse(JSON.parse(row.state_json));
  if (input !== undefined && "evidenceTypes" in state.input) {
    const snapshot = state.input;
    const evidence = snapshot.evidence.filter((item) =>
      snapshot.evidenceTypes[item.messageId]?.includes(module),
    );
    if (
      evidence.length !== input.evidence.length ||
      input.evidence.some(
        (item) =>
          JSON.stringify(evidence.find((candidate) => candidate.messageId === item.messageId)) !==
          JSON.stringify(item),
      )
    )
      fail("memory_curator_snapshot_scope_changed");
    if (
      module === "semantic" &&
      "allowedSubjectRefs" in input &&
      JSON.stringify(snapshot.allowedSubjectRefs) !== JSON.stringify(input.allowedSubjectRefs)
    )
      fail("memory_curator_snapshot_scope_changed");
  }
  const output = state.results[module];
  const provenance = state.resultProvenance[module];
  return output === undefined || provenance === undefined ? undefined : { output, provenance };
}

/** A reserved, idempotent same-conversation command is recoverable; an unknown model turn is not. */
export function hasPendingMemoryExtractionContinuation(
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
    if (version < 2) return false;
    if (version > 2) fail("memory_curator_session_version_unsupported");
    const row = db
      .prepare(
        `SELECT state_json FROM sessions WHERE module = 'conversation' AND json_extract(state_json, '$.input.jobs.${module}.jobId') = ? AND json_extract(state_json, '$.input.jobs.${module}.watermark') = ? ORDER BY json_extract(state_json, '$.retryGeneration') DESC, rowid DESC LIMIT 1`,
      )
      .get(jobId, watermark) as { state_json: string } | undefined;
    return (
      row !== undefined && State.parse(JSON.parse(row.state_json)).pendingContinuation !== undefined
    );
  } finally {
    db.close();
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
    if (version !== 1 && version !== 2) fail("memory_curator_session_version_unsupported");
    const row = db
      .prepare("SELECT state_json FROM sessions WHERE key = ?")
      .get(keyFor(module, jobId, watermark)) as { state_json: string } | undefined;
    if (row === undefined)
      return version === 2 && sourceReceipt(db, module, jobId, watermark) !== undefined;
    const state = (version === 1 ? CuratorSessionV1Schema : State).parse(
      JSON.parse(row.state_json),
    );
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
            "BEGIN IMMEDIATE; CREATE TABLE sessions (key TEXT PRIMARY KEY, module TEXT NOT NULL, job_id TEXT NOT NULL, updated_at TEXT NOT NULL, state_json TEXT NOT NULL); CREATE TABLE missions (mission_id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES sessions(key) ON DELETE CASCADE); PRAGMA user_version = 2; COMMIT;",
          );
        } else {
          if (version > 2) fail("memory_curator_session_version_unsupported");
          await runAdjacentSqliteMigrations({
            database: db,
            databasePath: path,
            family: "memory-curator-sessions",
            targetVersion: 2,
            migrations: CURATOR_SESSION_MIGRATIONS,
          });
        }
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
  async function guardCurrent(
    guard: MemoryExtractionSessionGuard,
    snapshot?: SessionState,
  ): Promise<void> {
    guard.signal?.throwIfAborted();
    await guard.assertAccess?.();
    if (snapshot !== undefined && guard.assertEvidenceAccess !== undefined) {
      for (const type of snapshot.contextTypes)
        await guard.assertEvidenceAccess(
          snapshot.input.evidence.filter(
            (item) =>
              !("evidenceTypes" in snapshot.input) ||
              snapshot.input.evidenceTypes[item.messageId]?.includes(type),
          ),
          type,
        );
    }
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
      "list_existing_memory",
      initial.module === "semantic" ? "submit_fact" : "submit_episode_part",
      "finish_extraction",
    ];
    if (initial.module === "conversation") toolNames.splice(toolNames.length - 1, 0, "submit_fact");
    return {
      key: initial.key,
      module: initial.module,
      toolNames,
      prompt: () => renderTask(initial),
      assertCurrent: async () => await guardCurrent(guard, initial),
      async bindMission(missionId) {
        await transaction((db) => {
          const state = read(db, initial.key)!;
          if (state.missionId !== undefined && state.missionId !== missionId)
            fail("memory_curator_mission_already_bound");
          const binding = db
            .prepare("SELECT session_key FROM missions WHERE mission_id = ?")
            .get(missionId) as { session_key: string } | undefined;
          if (binding !== undefined && binding.session_key !== initial.key)
            fail("memory_curator_mission_already_bound");
          db.prepare("INSERT OR IGNORE INTO missions(mission_id, session_key) VALUES (?, ?)").run(
            missionId,
            initial.key,
          );
          state.missionId = missionId;
          save(db, state);
        });
      },
      async executionState() {
        return await transaction((db) => {
          const { missionId, continuations, pendingContinuation, provenance, admitted } = read(
            db,
            initial.key,
          )!;
          return { missionId, continuations, pendingContinuation, provenance, admitted };
        });
      },
      async markAdmitted() {
        await guardCurrent(guard, initial);
        await transaction((db) => {
          const state = read(db, initial.key)!;
          state.admitted = true;
          save(db, state);
        });
      },
      async reserveContinuation(input) {
        await guardCurrent(guard, initial);
        return await transaction((db) => {
          const state = read(db, initial.key)!;
          if (state.pendingContinuation !== undefined) return state.pendingContinuation;
          if (state.continuations >= 3) fail("memory_curator_continuations_exhausted");
          if (
            state.calls >= MEMORY_EXTRACTION_LIMITS.calls ||
            state.deliveredTokens >= state.tokenLimit
          )
            fail("memory_curator_budget_exhausted");
          state.continuations++;
          const digest = createHash("sha256")
            .update(`${state.key}:continue:${state.retryGeneration}:${state.continuations}`)
            .digest("hex");
          state.pendingContinuation = {
            ...input,
            requestId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
            retryAt: new Date(now().getTime() + 5000).toISOString(),
          };
          save(db, state);
          return state.pendingContinuation;
        });
      },
      async acknowledgeContinuation(requestId) {
        await transaction((db) => {
          const state = read(db, initial.key)!;
          if (state.pendingContinuation?.requestId === requestId) {
            delete state.pendingContinuation;
            save(db, state);
          }
        });
      },
      async completed() {
        return await transaction((db) => read(db, initial.key)!.output !== undefined);
      },
      async pendingTypes() {
        return await transaction((db) => {
          const state = read(db, initial.key)!;
          const targets =
            "targets" in state.input
              ? state.input.targets
              : state.module === "conversation"
                ? []
                : [state.module];
          return targets.filter((type) => state.results[type] === undefined);
        });
      },
      async receiptFor(type) {
        return await transaction((db) => {
          const state = read(db, initial.key)!;
          const output = state.results[type];
          const provenance = state.resultProvenance[type];
          return output === undefined || provenance === undefined
            ? undefined
            : { output, provenance };
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
          await guardCurrent(guard, initial);
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
        // Reserve calls before embedding I/O without holding the shared Session lock.
        let reserved = false;
        let prepared:
          | {
              result: Awaited<
                ReturnType<NonNullable<MemoryExtractionSessionGuard["memory"]>["search"]>
              >;
            }
          | { error: unknown }
          | undefined;
        const search =
          name === "find_existing_memory"
            ? MemoryExtractionToolSchemas.find_existing_memory.safeParse(args)
            : undefined;
        if (
          guard.memory !== undefined &&
          search?.success &&
          search.data.query.trim() !== "" &&
          search.data.memory === undefined &&
          search.data.fact === undefined
        ) {
          reserved = await transaction((db) => {
            const state = read(db, initial.key)!;
            if (state.output !== undefined || state.calls >= MEMORY_EXTRACTION_LIMITS.calls)
              return false;
            state.calls++;
            state.updatedAt = now().toISOString();
            save(db, state);
            return true;
          });
          if (reserved) {
            try {
              prepared = {
                result: await guard.memory.search({
                  query: search.data.query,
                  mode: search.data.mode,
                  type: search.data.type,
                  limit: search.data.limit,
                  signal: guard.signal,
                }),
              };
            } catch (error) {
              prepared = { error };
            }
          }
        }
        const cached = prepared;
        const operationGuard =
          cached === undefined || guard.memory === undefined
            ? guard
            : {
                ...guard,
                memory: {
                  intersect: (
                    others: readonly import("../../retrieval/extraction-memory.ts").ExtractionMemoryAccess[],
                  ) => guard.memory!.intersect(others),
                  assertAccess: () => guard.memory!.assertAccess(),
                  fingerprint: guard.memory.fingerprint,
                  subjects: guard.memory.subjects,
                  list: (type: Parameters<typeof guard.memory.list>[0]) => guard.memory!.list(type),
                  get: (handle: string) => guard.memory!.get(handle),
                  async search() {
                    if ("error" in cached) throw cached.error;
                    return cached.result;
                  },
                },
              };
        const outcome = await transaction(async (db) => {
          const state = read(db, initial.key)!;
          if (state.output !== undefined)
            return { text: "Extraction already finished. The durable receipt is available." };
          const before = State.parse(state);
          if (!reserved) state.calls++;
          try {
            if (
              !reserved &&
              state.calls > MEMORY_EXTRACTION_LIMITS.calls &&
              name !== "finish_extraction"
            )
              fail("memory_curator_budget_exhausted");
            const parsed = MemoryExtractionToolSchemas[name].parse(args);
            const text = await callTool(state, name, parsed, operationGuard);
            await guardCurrent(guard, initial);
            delete state.lastError;
            state.updatedAt = now().toISOString();
            save(db, state);
            return { text };
          } catch (error) {
            await guardCurrent(guard, initial);
            before.calls = state.calls;
            before.lastError =
              error instanceof Error ? error.message : "memory_curator_tool_failed";
            before.updatedAt = now().toISOString();
            save(db, before);
            return { error };
          }
        });
        if ("error" in outcome) throw outcome.error;
        if (name === "finish_extraction" && guard.onResult !== undefined) {
          for (const type of ["episodic", "semantic"] as const) {
            const receipt = await this.receiptFor(type);
            if (receipt !== undefined) await guard.onResult(type, receipt);
          }
        }
        return outcome.text;
      },
      async deliverErrorResponse(text) {
        const outcome = await transaction((db) => {
          const state = read(db, initial.key)!;
          const remaining = state.tokenLimit - state.deliveredTokens;
          if (state.lastError === "memory_curator_budget_exhausted" || remaining <= 1) {
            state.lastError = "memory_curator_budget_exhausted";
            save(db, state);
            return undefined;
          }
          const bounded = boundedPrefix(
            text,
            Math.min(remaining, MEMORY_EXTRACTION_LIMITS.responseTokens),
          );
          if (bounded.length === 0) {
            state.lastError = "memory_curator_budget_exhausted";
            save(db, state);
            return undefined;
          }
          const response = deliver(state, bounded);
          state.updatedAt = now().toISOString();
          save(db, state);
          return response;
        });
        if (outcome === undefined) fail("memory_curator_budget_exhausted");
        return outcome;
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
        module: "episodic" | "semantic" | "conversation";
        input: MemoryExtractionInput;
        watermark: string;
      } & MemoryExtractionSessionGuard,
    ): Promise<MemoryExtractionSession> {
      let key = keyFor(input.module, input.input.jobId, input.watermark);
      const state = await transaction((db) => {
        db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(
          new Date(
            now().getTime() - DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs,
          ).toISOString(),
        );
        const source =
          input.module === "conversation"
            ? (db
                .prepare(
                  "SELECT key FROM sessions WHERE module = 'conversation' AND job_id = ? ORDER BY json_extract(state_json, '$.retryGeneration') DESC, rowid DESC LIMIT 1",
                )
                .get(input.input.jobId) as { key: string } | undefined)
            : undefined;
        let existing = read(db, source?.key ?? key);
        let retryGeneration = 0;
        if (input.module === "conversation" && existing?.restartPending === true) {
          retryGeneration = existing.retryGeneration;
          key = createHash("sha256")
            .update(JSON.stringify([key, retryGeneration, existing.key]))
            .digest("hex");
          existing.restartPending = false;
          save(db, existing);
          existing = read(db, key);
        }
        if (existing !== undefined) {
          if (
            input.module === "conversation" &&
            "targets" in input.input &&
            "jobs" in existing.input
          ) {
            const requested = input.input.targets;
            if (
              "targets" in existing.input &&
              existing.input.targets.some(
                (type) => !requested.includes(type) && existing.results[type] === undefined,
              )
            )
              fail("memory_curator_companion_not_ready");
            for (const type of input.input.targets) {
              const requested = input.input.jobs[type];
              const stored = existing.input.jobs[type];
              if (requested === undefined || JSON.stringify(requested) !== JSON.stringify(stored))
                fail("memory_curator_snapshot_scope_changed");
              const subset = {
                ...input.input,
                evidence: input.input.evidence.filter(
                  (item) =>
                    "evidenceTypes" in input.input &&
                    input.input.evidenceTypes[item.messageId]?.includes(type),
                ),
              };
              sourceReceipt(db, type, requested.jobId, requested.watermark, subset);
            }
          } else assertSnapshotScope(existing, input.input);
          if (existing.output === undefined && existing.module !== "conversation") {
            existing.calls = 0;
            existing.deliveredTokens = 0;
            delete existing.lastError;
            save(db, existing);
          }
          return existing;
        }
        if (input.module === "conversation" && "jobs" in input.input) {
          for (const type of ["episodic", "semantic"] as const) {
            const source = input.input.jobs[type];
            if (source === undefined) continue;
            const legacy = read(db, keyFor(type, source.jobId, source.watermark));
            if (legacy?.missionId !== undefined && legacy.output === undefined)
              fail("memory_curator_legacy_session_requires_attention");
          }
        }
        const count = (
          db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }
        ).count;
        if (count >= DEFAULT_MEMORY_STORAGE_POLICY.curatorRegistryMaxEntries)
          fail("memory_curator_session_capacity");
        const timestamp = now().toISOString();
        const state = State.parse({
          schemaVersion: "pragma.memory-curator-session/v2",
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
          results: {},
          resultProvenance: {},
          continuations: 0,
          admitted: false,
          retryGeneration,
          contextTypes:
            input.module === "conversation" && "targets" in input.input
              ? input.input.targets
              : [input.module],
          restartPending: false,
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
          : sourceReceipt(db, module, jobId, watermark, input);
      });
    },
    async deleteJobs(
      module: "episodic" | "semantic",
      jobIds: readonly string[],
      includeConversation = false,
    ): Promise<void> {
      await transaction((db) => {
        for (const id of jobIds) {
          db.prepare("DELETE FROM sessions WHERE module = ? AND job_id = ?").run(module, id);
          if (includeConversation)
            db.prepare(
              `DELETE FROM sessions WHERE module = 'conversation' AND json_extract(state_json, '$.input.jobs.${module}.jobId') = ?`,
            ).run(id);
        }
      });
    },
    async retryConversation(
      jobId: string,
      restart = false,
      pendingTypes: readonly ("episodic" | "semantic")[] = [],
    ): Promise<void> {
      await transaction((db) => {
        const rows = db
          .prepare("SELECT key FROM sessions WHERE module = 'conversation' AND job_id = ?")
          .all(jobId) as { key: string }[];
        for (const { key } of rows) {
          const state = read(db, key)!;
          state.continuations = 0;
          state.retryGeneration++;
          if (restart) delete state.pendingContinuation;
          delete state.lastError;
          if (restart) {
            state.restartPending = true;
            if (pendingTypes.length > 0) state.contextTypes = [...pendingTypes];
            for (const type of pendingTypes) {
              delete state.results[type];
              delete state.resultProvenance[type];
              if (type === "semantic") state.candidates = {};
              else state.parts = {};
            }
            delete state.output;
            delete state.missionId;
            state.admitted = false;
            delete state.provenance;
            state.calls = 0;
            state.deliveredTokens = 0;
            state.read = {};
            markInlineRead(state);
          }
          save(db, state);
        }
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
