import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import {
  MemoryEvidenceEnvelopeSchema,
  SemanticFactSchema,
  type MemoryEvidenceEnvelope,
  type MemoryRevisionBinding,
  type MemorySubjectRef,
  type MemoryVisibilityPolicy,
  type SemanticFact,
  type SemanticFactExtractorProvenance,
} from "@pragma/shared";

import {
  SemanticExecutionSubjectContextSchema,
  SemanticExtractionJobSchema,
  SemanticGovernanceEventSchema,
  type SemanticExecutionSubjectContext,
  type SemanticExtractionJob,
  type SemanticFactCandidate,
  type SemanticGovernanceEvent,
} from "./schema.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";

export type SemanticRejectionReason =
  "no-stable-fact" | "insufficient-evidence" | "sensitive" | "policy";

export interface SemanticMemoryStoreDiagnostic {
  readonly facts: number;
  readonly pending: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly rejected: number;
  readonly rejectedByReason: Readonly<Record<SemanticRejectionReason, number>>;
}

export interface SemanticFactMaterialization {
  readonly job: SemanticExtractionJob;
  readonly candidates: readonly SemanticFactCandidate[];
  readonly evidence: readonly MemoryEvidenceEnvelope[];
  readonly rootRef: MemorySubjectRef;
  readonly producerRefs: readonly MemorySubjectRef[];
  readonly visibility: MemoryVisibilityPolicy;
  readonly sensitivity: "public" | "internal" | "confidential" | "restricted";
  readonly extractor: SemanticFactExtractorProvenance;
  readonly now: Date;
}

export interface SemanticFactRevisionInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly actorRef: MemorySubjectRef;
  readonly reason: string;
  readonly patch: {
    readonly statement?: string | undefined;
    readonly predicate?: string | undefined;
    readonly normalizedValue?: string | undefined;
    readonly conflictMode?: "exclusive" | "compatible" | undefined;
    readonly confidence?: number | undefined;
    readonly reviewAt?: string | null | undefined;
    readonly expiresAt?: string | null | undefined;
  };
  readonly now: Date;
}

export interface SemanticMemoryStore {
  ingest(envelopes: readonly MemoryEvidenceEnvelope[]): Promise<void>;
  registerSubjectContext(context: SemanticExecutionSubjectContext): Promise<void>;
  getSubjectContext(executionId: string): Promise<SemanticExecutionSubjectContext | undefined>;
  claimDueJob(now: Date): Promise<SemanticExtractionJob | undefined>;
  readEvidence(executionId: string): Promise<readonly MemoryEvidenceEnvelope[]>;
  hasAppliedJob(jobId: string): Promise<boolean>;
  completePreviouslyApplied(job: SemanticExtractionJob): Promise<void>;
  completeRetained(input: SemanticFactMaterialization): Promise<readonly SemanticFact[]>;
  completeRejected(job: SemanticExtractionJob, reason: SemanticRejectionReason): Promise<void>;
  fail(input: {
    readonly job: SemanticExtractionJob;
    readonly errorCode: string;
    readonly now: Date;
    readonly retry: "transient" | "configuration";
  }): Promise<void>;
  wakeNeedsAttention(now: Date): Promise<void>;
  list(): Promise<readonly SemanticFact[]>;
  search(query: string, limit: number): Promise<readonly SemanticFact[]>;
  get(id: string): Promise<SemanticFact | undefined>;
  history(id: string): Promise<readonly SemanticFact[]>;
  listForRecall(scope: MemoryRecallScope, now: Date): Promise<readonly SemanticFact[]>;
  searchForRecall(
    scope: MemoryRecallScope,
    query: string,
    limit: number,
    now: Date,
  ): Promise<readonly SemanticFact[]>;
  getForRecall(scope: MemoryRecallScope, id: string, now: Date): Promise<SemanticFact | undefined>;
  getEvidenceForRecall(
    scope: MemoryRecallScope,
    messageId: string,
    now: Date,
  ): Promise<MemoryEvidenceEnvelope | undefined>;
  revise(input: SemanticFactRevisionInput): Promise<SemanticFact>;
  verify(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly actorRef: MemorySubjectRef;
    readonly reason: string;
    readonly now: Date;
  }): Promise<SemanticFact>;
  invalidate(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly actorRef: MemorySubjectRef;
    readonly reason: string;
    readonly now: Date;
  }): Promise<SemanticFact>;
  inspect(): Promise<SemanticMemoryStoreDiagnostic>;
  close(): void;
}

export async function createSemanticMemoryStore(
  options: { readonly pragmaHome?: string | undefined } = {},
): Promise<SemanticMemoryStore> {
  const paths = new PragmaPaths(options);
  const moduleId = "pragma.memory.semantic";
  const dataRoot = paths.memoryModuleDataRoot(moduleId);
  const stateRoot = paths.memoryModuleStateRoot(moduleId);
  await Promise.all([
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
  ]);
  const data = new DatabaseSync(join(dataRoot, "facts.sqlite"));
  const state = new DatabaseSync(join(stateRoot, "jobs.sqlite"));
  try {
    initializeData(data);
    initializeState(state);
  } catch (error) {
    tryClose(data);
    tryClose(state);
    throw error;
  }

  const writeJob = (job: SemanticExtractionJob): void => {
    state
      .prepare(
        `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, retry_at=excluded.retry_at,
           lease_until=excluded.lease_until, job_json=excluded.job_json`,
      )
      .run(
        job.id,
        job.executionId,
        job.terminalMessageId,
        job.status,
        job.retryAt ?? null,
        job.leaseUntil ?? null,
        JSON.stringify(job),
      );
  };

  const finishJob = (job: SemanticExtractionJob, completion: "retained" | "rejected"): void => {
    const finished = SemanticExtractionJobSchema.parse({
      ...job,
      status: "completed",
      completion,
      retryAt: undefined,
      leaseUntil: undefined,
      lastErrorCode: undefined,
      updatedAt: new Date().toISOString(),
    });
    writeJob(finished);
    state.prepare("DELETE FROM evidence WHERE execution_id = ?").run(job.executionId);
  };

  const governanceMutation = (
    action: "revise" | "verify" | "invalidate",
    input: {
      readonly id: string;
      readonly expectedRevision: number;
      readonly actorRef: MemorySubjectRef;
      readonly reason: string;
      readonly now: Date;
    },
    mutate: (current: SemanticFact) => SemanticFact,
  ): SemanticFact => {
    data.exec("BEGIN IMMEDIATE;");
    try {
      const current = readFact(data, input.id);
      if (current === undefined) throw new Error("semantic_fact_not_found");
      if (current.revision !== input.expectedRevision) {
        throw revisionConflict(input.expectedRevision, current.revision);
      }
      let next = SemanticFactSchema.parse(mutate(current));
      assertNoDuplicate(data, next);
      persistFactRevision(data, next);
      const mutable = new Set([next.id]);
      recomputeConflicts(data, mutable);
      next = readRequiredFact(data, next.id);
      const event = SemanticGovernanceEventSchema.parse({
        schemaVersion: "pragma.memory-semantic-governance-event/v1",
        id: randomUUID(),
        factId: next.id,
        previousRevision: current.revision,
        revision: next.revision,
        action,
        reason: input.reason,
        actorRef: input.actorRef,
        occurredAt: input.now.toISOString(),
      });
      insertGovernanceEvent(data, event);
      data.exec("COMMIT;");
      return next;
    } catch (error) {
      rollback(data);
      throw error;
    }
  };

  return {
    async ingest(envelopes) {
      if (envelopes.length === 0) return;
      const insertEvidence = state.prepare(
        `INSERT OR IGNORE INTO evidence(message_id, execution_id, occurred_at, envelope_json)
         VALUES (?, ?, ?, ?)`,
      );
      state.exec("BEGIN IMMEDIATE;");
      try {
        for (const raw of envelopes) {
          const envelope = MemoryEvidenceEnvelopeSchema.parse(raw);
          if (envelope.correlationId === undefined) continue;
          insertEvidence.run(
            envelope.messageId,
            envelope.correlationId,
            envelope.occurredAt,
            JSON.stringify(envelope),
          );
          if (envelope.topic !== "execution.execution.terminal") continue;
          const id = semanticJobId(envelope.messageId);
          if (readJob(state, id) !== undefined) continue;
          writeJob(
            SemanticExtractionJobSchema.parse({
              schemaVersion: "pragma.memory-semantic-job/v1",
              id,
              executionId: envelope.correlationId,
              terminalMessageId: envelope.messageId,
              status: "pending",
              attempts: 0,
              updatedAt: envelope.occurredAt,
            }),
          );
        }
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async registerSubjectContext(raw) {
      const context = SemanticExecutionSubjectContextSchema.parse(raw);
      state
        .prepare(
          `INSERT INTO subject_contexts(execution_id, context_json) VALUES (?, ?)
           ON CONFLICT(execution_id) DO UPDATE SET context_json=excluded.context_json`,
        )
        .run(context.executionId, JSON.stringify(context));
      const rows = state
        .prepare(
          "SELECT job_json AS jobJson FROM jobs WHERE execution_id = ? AND status = 'needs_attention'",
        )
        .all(context.executionId) as unknown as readonly { readonly jobJson: string }[];
      for (const row of rows) {
        const job = SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson));
        if (job.lastErrorCode !== "semantic_subject_context_missing") continue;
        writeJob(
          SemanticExtractionJobSchema.parse({
            ...job,
            status: "pending",
            retryAt: context.registeredAt,
            lastErrorCode: undefined,
            updatedAt: context.registeredAt,
          }),
        );
      }
    },

    async getSubjectContext(executionId) {
      const row = state
        .prepare("SELECT context_json AS contextJson FROM subject_contexts WHERE execution_id = ?")
        .get(executionId) as { readonly contextJson: string } | undefined;
      return row === undefined
        ? undefined
        : SemanticExecutionSubjectContextSchema.parse(JSON.parse(row.contextJson));
    },

    async claimDueJob(now) {
      state.exec("BEGIN IMMEDIATE;");
      try {
        const row = state
          .prepare(
            `SELECT job_json AS jobJson FROM jobs
             WHERE (status = 'pending' AND (retry_at IS NULL OR retry_at <= ?))
                OR (status = 'running' AND lease_until <= ?)
             ORDER BY retry_at IS NOT NULL, retry_at, id LIMIT 1`,
          )
          .get(now.toISOString(), now.toISOString()) as unknown as
          { readonly jobJson: string } | undefined;
        if (row === undefined) {
          state.exec("COMMIT;");
          return undefined;
        }
        const current = SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson));
        const claimed = SemanticExtractionJobSchema.parse({
          ...current,
          status: "running",
          attempts: current.attempts + 1,
          retryAt: undefined,
          leaseUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
          updatedAt: now.toISOString(),
        });
        writeJob(claimed);
        state.exec("COMMIT;");
        return claimed;
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async readEvidence(executionId) {
      const rows = state
        .prepare(
          "SELECT envelope_json AS envelopeJson FROM evidence WHERE execution_id = ? ORDER BY occurred_at, message_id",
        )
        .all(executionId) as unknown as readonly { readonly envelopeJson: string }[];
      const retained = data
        .prepare(
          `SELECT DISTINCT e.envelope_json AS envelopeJson FROM evidence e
           JOIN fact_evidence fe ON fe.evidence_id = e.message_id
           JOIN current_facts f ON f.id = fe.fact_id
           WHERE json_extract(e.envelope_json, '$.correlationId') = ?`,
        )
        .all(executionId) as unknown as readonly { readonly envelopeJson: string }[];
      const unique = new Map<string, MemoryEvidenceEnvelope>();
      for (const row of [...retained, ...rows]) {
        const envelope = MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
        unique.set(envelope.messageId, envelope);
      }
      return [...unique.values()]
        .toSorted(
          (left, right) =>
            left.occurredAt.localeCompare(right.occurredAt) ||
            left.messageId.localeCompare(right.messageId),
        )
        .slice(-2_000);
    },

    async hasAppliedJob(jobId) {
      return (
        data.prepare("SELECT 1 AS found FROM applied_jobs WHERE job_id = ?").get(jobId) !==
        undefined
      );
    },

    async completePreviouslyApplied(job) {
      state.exec("BEGIN IMMEDIATE;");
      try {
        finishJob(job, "retained");
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async completeRetained(input) {
      const evidenceById = new Map(input.evidence.map((item) => [item.messageId, item]));
      const touched = new Set<string>();
      data.exec("BEGIN IMMEDIATE;");
      try {
        if (data.prepare("SELECT 1 FROM applied_jobs WHERE job_id = ?").get(input.job.id)) {
          data.exec("COMMIT;");
        } else {
          for (const candidate of input.candidates) {
            const subjects = uniqueRefs(candidate.subjectRefs);
            let existing = findEquivalentFact(data, subjects, candidate);
            const cited = candidate.evidenceRefs.map((id) => {
              const envelope = evidenceById.get(id);
              if (envelope === undefined) throw new Error(`semantic_evidence_ref_invalid:${id}`);
              return envelope;
            });
            const observedAt = cited
              .map((item) => item.occurredAt)
              .toSorted()
              .at(-1)!;
            const mergedVisibility =
              existing === undefined
                ? input.visibility
                : intersectVisibility(existing.visibility, input.visibility);
            if (mergedVisibility === undefined) existing = undefined;
            const timestamp = input.now.toISOString();
            const priorRevision = existing?.revision;
            const id = existing?.id ?? semanticFactId(input.job.id, candidate);
            const record = SemanticFactSchema.parse({
              schemaVersion: "pragma.memory-semantic/v1",
              id,
              revision: (existing?.revision ?? 0) + 1,
              statement: candidate.statement,
              subjectRefs: subjects,
              predicate: candidate.predicate,
              normalizedValue: candidate.normalizedValue,
              conflictMode: candidate.conflictMode,
              confidence: Math.max(existing?.confidence ?? 0, candidate.confidence),
              observedAt:
                existing === undefined
                  ? observedAt
                  : [existing.observedAt, observedAt].toSorted()[0],
              ...(existing?.verifiedAt === undefined ? {} : { verifiedAt: existing.verifiedAt }),
              ...optionalTime("reviewAt", earliestTime(existing?.reviewAt, candidate.reviewAt)),
              ...optionalTime("expiresAt", earliestTime(existing?.expiresAt, candidate.expiresAt)),
              evidenceRefs: uniqueStrings([
                ...(existing?.evidenceRefs ?? []),
                ...candidate.evidenceRefs,
              ]),
              conflictsWith: existing?.conflictsWith ?? [],
              supersedes:
                priorRevision === undefined
                  ? []
                  : appendRevisionRef(existing!.supersedes, id, priorRevision),
              status: "active",
              visibility: mergedVisibility ?? input.visibility,
              sensitivity: strictestSensitivity(existing?.sensitivity, input.sensitivity),
              bindings: mergeBindings(existing?.bindings ?? [], input.rootRef),
              rootRefs: uniqueRefs([...(existing?.rootRefs ?? []), input.rootRef]),
              producerRefs: uniqueRefs([...(existing?.producerRefs ?? []), ...input.producerRefs]),
              extractor: input.extractor,
              createdAt: existing?.createdAt ?? timestamp,
              updatedAt: timestamp,
            });
            persistFactRevision(data, record);
            touched.add(record.id);
            for (const envelope of cited) {
              data
                .prepare(
                  "INSERT OR IGNORE INTO evidence(message_id, occurred_at, envelope_json) VALUES (?, ?, ?)",
                )
                .run(envelope.messageId, envelope.occurredAt, JSON.stringify(envelope));
              data
                .prepare("INSERT OR IGNORE INTO fact_evidence(fact_id, evidence_id) VALUES (?, ?)")
                .run(record.id, envelope.messageId);
            }
          }
          recomputeConflicts(data, touched);
          data
            .prepare(
              "INSERT INTO applied_jobs(job_id, terminal_message_id, applied_at) VALUES (?, ?, ?)",
            )
            .run(input.job.id, input.job.terminalMessageId, input.now.toISOString());
          data.exec("COMMIT;");
        }
      } catch (error) {
        rollback(data);
        throw error;
      }
      state.exec("BEGIN IMMEDIATE;");
      try {
        finishJob(input.job, "retained");
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
      return [...touched].map((id) => readRequiredFact(data, id));
    },

    async completeRejected(job, reason) {
      state.exec("BEGIN IMMEDIATE;");
      try {
        finishJob(job, "rejected");
        incrementCounter(state, "rejected_total");
        incrementCounter(state, `rejected_${reason.replaceAll("-", "_")}`);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async fail(input) {
      const needsAttention = input.retry === "configuration" || input.job.attempts >= 3;
      const delay = input.job.attempts <= 1 ? 60_000 : 5 * 60_000;
      writeJob(
        SemanticExtractionJobSchema.parse({
          ...input.job,
          status: needsAttention ? "needs_attention" : "pending",
          leaseUntil: undefined,
          ...(needsAttention
            ? { retryAt: undefined }
            : { retryAt: new Date(input.now.getTime() + delay).toISOString() }),
          lastErrorCode: input.errorCode,
          updatedAt: input.now.toISOString(),
        }),
      );
    },

    async wakeNeedsAttention(now) {
      const rows = state
        .prepare("SELECT job_json AS jobJson FROM jobs WHERE status = 'needs_attention'")
        .all() as unknown as readonly { readonly jobJson: string }[];
      for (const row of rows) {
        const job = SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson));
        writeJob(
          SemanticExtractionJobSchema.parse({
            ...job,
            status: "pending",
            retryAt: now.toISOString(),
            lastErrorCode: undefined,
            updatedAt: now.toISOString(),
          }),
        );
      }
    },

    async list() {
      return readFactRows(
        data
          .prepare(
            "SELECT record_json AS recordJson FROM current_facts ORDER BY updated_at DESC, id",
          )
          .all(),
      );
    },

    async search(query, limit) {
      return searchFacts(data, undefined, query, limit, new Date(8640000000000000));
    },

    async get(id) {
      return readFact(data, id);
    },

    async history(id) {
      return readFactRows(
        data
          .prepare(
            "SELECT record_json AS recordJson FROM fact_revisions WHERE fact_id = ? ORDER BY revision DESC",
          )
          .all(id),
      );
    },

    async listForRecall(scope, now) {
      const access = recallPredicate("current_facts", scope, now);
      return readFactRows(
        data
          .prepare(
            `SELECT record_json AS recordJson FROM current_facts WHERE ${access.sql}
             ORDER BY json_extract(record_json, '$.verifiedAt') IS NOT NULL DESC,
               json_extract(record_json, '$.confidence') DESC, updated_at DESC, id`,
          )
          .all(...access.parameters),
      );
    },

    async searchForRecall(scope, query, limit, now) {
      return searchFacts(data, scope, query, limit, now);
    },

    async getForRecall(scope, id, now) {
      const access = recallPredicate("current_facts", scope, now);
      const row = data
        .prepare(
          `SELECT record_json AS recordJson FROM current_facts WHERE id = ? AND ${access.sql}`,
        )
        .get(id, ...access.parameters) as { readonly recordJson: string } | undefined;
      return row === undefined ? undefined : SemanticFactSchema.parse(JSON.parse(row.recordJson));
    },

    async getEvidenceForRecall(scope, messageId, now) {
      const access = recallPredicate("f", scope, now);
      const row = data
        .prepare(
          `SELECT e.envelope_json AS envelopeJson FROM evidence e
           JOIN fact_evidence fe ON fe.evidence_id = e.message_id
           JOIN current_facts f ON f.id = fe.fact_id
           WHERE e.message_id = ? AND ${access.sql} LIMIT 1`,
        )
        .get(messageId, ...access.parameters) as { readonly envelopeJson: string } | undefined;
      return row === undefined
        ? undefined
        : MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
    },

    async revise(input) {
      return governanceMutation("revise", input, (current) => {
        const timestamp = input.now.toISOString();
        return SemanticFactSchema.parse({
          ...current,
          ...definedPatch(input.patch),
          revision: current.revision + 1,
          supersedes: appendRevisionRef(current.supersedes, current.id, current.revision),
          updatedAt: timestamp,
        });
      });
    },

    async verify(input) {
      return governanceMutation("verify", input, (current) => ({
        ...current,
        revision: current.revision + 1,
        confidence: 1,
        verifiedAt: input.now.toISOString(),
        supersedes: appendRevisionRef(current.supersedes, current.id, current.revision),
        updatedAt: input.now.toISOString(),
      }));
    },

    async invalidate(input) {
      return governanceMutation("invalidate", input, (current) => ({
        ...current,
        revision: current.revision + 1,
        status: "invalidated",
        invalidatedAt: input.now.toISOString(),
        supersedes: appendRevisionRef(current.supersedes, current.id, current.revision),
        updatedAt: input.now.toISOString(),
      }));
    },

    async inspect() {
      const byStatus = new Map(
        (
          state
            .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
            .all() as unknown as readonly {
            readonly status: string;
            readonly count: number;
          }[]
        ).map((row) => [row.status, row.count]),
      );
      const counters = new Map(
        (
          state
            .prepare("SELECT name, value FROM counters WHERE name LIKE 'rejected_%'")
            .all() as unknown as readonly { readonly name: string; readonly value: number }[]
        ).map((row) => [row.name, row.value]),
      );
      const facts = data
        .prepare("SELECT COUNT(*) AS count FROM current_facts")
        .get() as unknown as {
        readonly count: number;
      };
      return {
        facts: facts.count,
        pending: byStatus.get("pending") ?? 0,
        running: byStatus.get("running") ?? 0,
        needsAttention: byStatus.get("needs_attention") ?? 0,
        rejected: counters.get("rejected_total") ?? 0,
        rejectedByReason: {
          "no-stable-fact": counters.get("rejected_no_stable_fact") ?? 0,
          "insufficient-evidence": counters.get("rejected_insufficient_evidence") ?? 0,
          sensitive: counters.get("rejected_sensitive") ?? 0,
          policy: counters.get("rejected_policy") ?? 0,
        },
      };
    },

    close() {
      state.close();
      data.close();
    },
  };
}

export function semanticFactId(jobId: string, candidate: SemanticFactCandidate): string {
  return `fact-${createHash("sha256")
    .update(
      JSON.stringify([
        jobId,
        subjectKey(candidate.subjectRefs),
        candidate.predicate,
        candidate.normalizedValue,
      ]),
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function semanticJobId(terminalMessageId: string): string {
  return `semantic-${createHash("sha256").update(terminalMessageId).digest("hex").slice(0, 24)}`;
}

function initializeData(database: DatabaseSync): void {
  assertVersion(database, "pragma.memory-semantic-store");
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS current_facts (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS semantic_facts_status_updated
      ON current_facts(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS fact_revisions (
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (fact_id, revision)
    );
    CREATE TABLE IF NOT EXISTS evidence (
      message_id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fact_evidence (
      fact_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      PRIMARY KEY (fact_id, evidence_id),
      FOREIGN KEY (fact_id) REFERENCES current_facts(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES evidence(message_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS applied_jobs (
      job_id TEXT PRIMARY KEY,
      terminal_message_id TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS governance_events (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
}

function initializeState(database: DatabaseSync): void {
  assertVersion(database, "pragma.memory-semantic-jobs");
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS evidence (
      message_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      envelope_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS semantic_evidence_execution
      ON evidence(execution_id, occurred_at);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      terminal_message_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      retry_at TEXT,
      lease_until TEXT,
      job_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS semantic_jobs_due ON jobs(status, retry_at, lease_until);
    CREATE TABLE IF NOT EXISTS subject_contexts (
      execution_id TEXT PRIMARY KEY,
      context_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    PRAGMA user_version = 1;
  `);
}

function assertVersion(database: DatabaseSync, family: string): void {
  const row = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  if (row.user_version > 1) {
    database.close();
    throw new Error(`unsupported-state-version:${family}/v${row.user_version}`);
  }
}

function readJob(database: DatabaseSync, id: string): SemanticExtractionJob | undefined {
  const row = database.prepare("SELECT job_json AS jobJson FROM jobs WHERE id = ?").get(id) as
    { readonly jobJson: string } | undefined;
  return row === undefined ? undefined : SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson));
}

function readFact(database: DatabaseSync, id: string): SemanticFact | undefined {
  const row = database
    .prepare("SELECT record_json AS recordJson FROM current_facts WHERE id = ?")
    .get(id) as { readonly recordJson: string } | undefined;
  return row === undefined ? undefined : SemanticFactSchema.parse(JSON.parse(row.recordJson));
}

function readRequiredFact(database: DatabaseSync, id: string): SemanticFact {
  const fact = readFact(database, id);
  if (fact === undefined) throw new Error("semantic_fact_not_found");
  return fact;
}

function readFactRows(rows: readonly unknown[]): SemanticFact[] {
  return (rows as readonly { readonly recordJson: string }[]).map((row) =>
    SemanticFactSchema.parse(JSON.parse(row.recordJson)),
  );
}

function persistFactRevision(database: DatabaseSync, fact: SemanticFact): void {
  const record = SemanticFactSchema.parse(fact);
  database
    .prepare(
      `INSERT INTO current_facts(id, revision, status, updated_at, record_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, status=excluded.status,
         updated_at=excluded.updated_at, record_json=excluded.record_json`,
    )
    .run(record.id, record.revision, record.status, record.updatedAt, JSON.stringify(record));
  database
    .prepare("INSERT INTO fact_revisions(fact_id, revision, record_json) VALUES (?, ?, ?)")
    .run(record.id, record.revision, JSON.stringify(record));
}

function replaceCurrentRevision(database: DatabaseSync, fact: SemanticFact): void {
  const record = SemanticFactSchema.parse(fact);
  database
    .prepare("UPDATE current_facts SET status = ?, updated_at = ?, record_json = ? WHERE id = ?")
    .run(record.status, record.updatedAt, JSON.stringify(record), record.id);
  database
    .prepare("UPDATE fact_revisions SET record_json = ? WHERE fact_id = ? AND revision = ?")
    .run(JSON.stringify(record), record.id, record.revision);
}

function findEquivalentFact(
  database: DatabaseSync,
  subjects: readonly MemorySubjectRef[],
  candidate: Pick<SemanticFactCandidate, "predicate" | "normalizedValue">,
): SemanticFact | undefined {
  return readFactRows(
    database
      .prepare(
        `SELECT record_json AS recordJson FROM current_facts
         WHERE status = 'active'
           AND json_extract(record_json, '$.predicate') = ?
           AND json_extract(record_json, '$.normalizedValue') = ?`,
      )
      .all(candidate.predicate, candidate.normalizedValue),
  ).find((fact) => subjectKey(fact.subjectRefs) === subjectKey(subjects));
}

function assertNoDuplicate(database: DatabaseSync, fact: SemanticFact): void {
  const duplicate = findEquivalentFact(database, fact.subjectRefs, fact);
  if (
    duplicate !== undefined &&
    duplicate.id !== fact.id &&
    intersectVisibility(duplicate.visibility, fact.visibility) !== undefined
  ) {
    throw new Error("semantic_fact_duplicate");
  }
}

function recomputeConflicts(database: DatabaseSync, mutable: ReadonlySet<string>): void {
  const facts = readFactRows(
    database
      .prepare("SELECT record_json AS recordJson FROM current_facts WHERE status = 'active'")
      .all(),
  );
  const desired = new Map<string, Set<string>>(facts.map((fact) => [fact.id, new Set()]));
  for (let leftIndex = 0; leftIndex < facts.length; leftIndex += 1) {
    const left = facts[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < facts.length; rightIndex += 1) {
      const right = facts[rightIndex]!;
      if (
        left.conflictMode !== "exclusive" ||
        right.conflictMode !== "exclusive" ||
        left.predicate !== right.predicate ||
        left.normalizedValue === right.normalizedValue ||
        subjectKey(left.subjectRefs) !== subjectKey(right.subjectRefs)
      ) {
        continue;
      }
      desired.get(left.id)!.add(right.id);
      desired.get(right.id)!.add(left.id);
    }
  }
  for (const fact of facts) {
    const conflictsWith = [...desired.get(fact.id)!].toSorted();
    if (sameStrings(fact.conflictsWith, conflictsWith)) continue;
    if (mutable.has(fact.id)) {
      replaceCurrentRevision(database, SemanticFactSchema.parse({ ...fact, conflictsWith }));
      continue;
    }
    persistFactRevision(
      database,
      SemanticFactSchema.parse({
        ...fact,
        revision: fact.revision + 1,
        conflictsWith,
        supersedes: appendRevisionRef(fact.supersedes, fact.id, fact.revision),
        updatedAt: new Date().toISOString(),
      }),
    );
  }
}

function searchFacts(
  database: DatabaseSync,
  scope: MemoryRecallScope | undefined,
  query: string,
  limit: number,
  now: Date,
): SemanticFact[] {
  const escaped = query
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const access = scope === undefined ? undefined : recallPredicate("current_facts", scope, now);
  return readFactRows(
    database
      .prepare(
        `SELECT record_json AS recordJson FROM current_facts
         WHERE lower(record_json) LIKE lower(?) ESCAPE '\\'
           ${access === undefined ? "" : `AND ${access.sql}`}
         ORDER BY json_extract(record_json, '$.verifiedAt') IS NOT NULL DESC,
           json_extract(record_json, '$.confidence') DESC, updated_at DESC, id LIMIT ?`,
      )
      .all(`%${escaped}%`, ...(access?.parameters ?? []), normalizedLimit),
  );
}

function recallPredicate(
  alias: "current_facts" | "f",
  scope: MemoryRecallScope,
  now: Date,
): { readonly sql: string; readonly parameters: readonly string[] } {
  const refs = uniqueRefs([scope.rootRef, scope.expertRef]);
  const clauses = refs.map(
    () =>
      `EXISTS (
        SELECT 1 FROM json_each(${alias}.record_json, '$.bindings') AS binding
        WHERE json_extract(binding.value, '$.consumerRef.type') = ?
          AND json_extract(binding.value, '$.consumerRef.id') = ?
          AND json_extract(binding.value, '$.recall') = 'allow'
      )`,
  );
  return {
    sql: `json_extract(${alias}.record_json, '$.status') = 'active'
      AND json_extract(${alias}.record_json, '$.visibility.mode') != 'restricted'
      AND (json_extract(${alias}.record_json, '$.expiresAt') IS NULL
        OR json_extract(${alias}.record_json, '$.expiresAt') > ?)
      AND (${clauses.join(" OR ")})`,
    parameters: [now.toISOString(), ...refs.flatMap((ref) => [ref.type, ref.id])],
  };
}

function insertGovernanceEvent(database: DatabaseSync, event: SemanticGovernanceEvent): void {
  database
    .prepare("INSERT INTO governance_events(id, fact_id, revision, event_json) VALUES (?, ?, ?, ?)")
    .run(event.id, event.factId, event.revision, JSON.stringify(event));
}

function definedPatch(patch: SemanticFactRevisionInput["patch"]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value === null ? undefined : value;
  }
  return result;
}

function intersectVisibility(
  left: MemoryVisibilityPolicy,
  right: MemoryVisibilityPolicy,
): MemoryVisibilityPolicy | undefined {
  if (left.mode === "restricted" && right.mode === "restricted") {
    const rightPrincipals = new Set(right.principals.map(refKey));
    const principals = left.principals.filter((ref) => rightPrincipals.has(refKey(ref)));
    return principals.length === 0 ? undefined : { mode: "restricted", principals };
  }
  if (left.mode === "restricted") return left;
  if (right.mode === "restricted") return right;
  if (left.mode === "host-private" || right.mode === "host-private") {
    return { mode: "host-private" };
  }
  return { mode: "public" };
}

function strictestSensitivity(
  left: SemanticFact["sensitivity"] | undefined,
  right: SemanticFact["sensitivity"],
): SemanticFact["sensitivity"] {
  if (left === undefined) return right;
  const order = ["public", "internal", "confidential", "restricted"] as const;
  return order[Math.max(order.indexOf(left), order.indexOf(right))]!;
}

function earliestTime(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return [left, right].toSorted()[0];
}

function optionalTime(
  key: "reviewAt" | "expiresAt",
  value: string | undefined,
): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function mergeBindings(
  existing: readonly MemoryRevisionBinding[],
  rootRef: MemorySubjectRef,
): MemoryRevisionBinding[] {
  const byRef = new Map(existing.map((binding) => [refKey(binding.consumerRef), binding]));
  if (!byRef.has(refKey(rootRef))) {
    byRef.set(refKey(rootRef), {
      consumerRef: rootRef,
      recall: "allow",
      export: "deny",
      permissionRevision: 1,
    });
  }
  return [...byRef.values()].map((binding) => ({ ...binding, export: "deny" as const }));
}

function appendRevisionRef(
  refs: readonly { readonly factId: string; readonly revision: number }[],
  factId: string,
  revision: number,
) {
  return [...refs, { factId, revision }].slice(-100);
}

function subjectKey(refs: readonly MemorySubjectRef[]): string {
  return uniqueRefs(refs)
    .map((ref) => `${ref.type}\0${ref.id}`)
    .toSorted()
    .join("\x01");
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [`${ref.type}\0${ref.id}`, ref])).values()].toSorted(
    (left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function revisionConflict(expected: number, actual: number): Error {
  const error = new Error("semantic_fact_revision_conflict");
  Object.assign(error, { expected, actual });
  return error;
}

function incrementCounter(database: DatabaseSync, name: string): void {
  database
    .prepare(
      `INSERT INTO counters(name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`,
    )
    .run(name);
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK;");
  } catch {
    // No transaction remained active.
  }
}

function tryClose(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // Best effort during initialization failure.
  }
}
