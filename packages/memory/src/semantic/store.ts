import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths, withFileLock } from "@pragma/core";
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
import {
  assertMemoryBindingsTightened,
  assertMemoryVisibilityTightened,
  createMemoryTombstone,
} from "../governance/access-governance.ts";
import {
  latestExtractionJobErrorCode,
  parseExtractionJobJson,
} from "../pipeline/extraction-job-diagnostic.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";
import {
  EMPTY_MEMORY_EVIDENCE_OMISSION_STATS,
  MemoryEvidenceOmissionStatsSchema,
  mergeMemoryEvidenceOmissionStats,
  selectBoundedMemoryEvidence,
  type MemoryEvidenceOmissionStats,
} from "../storage/bounded-evidence.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import { SEMANTIC_DATA_STORAGE_MIGRATIONS } from "../storage/migrations/semantic-data/index.ts";
import { SEMANTIC_JOB_STORAGE_MIGRATIONS } from "../storage/migrations/semantic-jobs/index.ts";
import {
  assertFreshSqliteDatabase,
  removeExpiredSqliteMigrationBackup,
  runAdjacentSqliteMigrations,
} from "../storage/sqlite-migration-backup.ts";

export type SemanticRejectionReason =
  "no-stable-fact" | "insufficient-evidence" | "sensitive" | "policy";

export interface SemanticMemoryStoreDiagnostic {
  readonly facts: number;
  readonly pending: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly expired: number;
  readonly evidenceRecords: number;
  readonly evidenceBytes: number;
  readonly truncatedExecutions: number;
  readonly rejected: number;
  readonly lastErrorCode?: string | undefined;
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

export interface SemanticGovernanceInput {
  readonly id: string;
  readonly expectedRevision: number;
  readonly actorRef: MemorySubjectRef;
  readonly reason: string;
  readonly now: Date;
}

export interface SemanticMemoryStore {
  ingest(envelopes: readonly MemoryEvidenceEnvelope[]): Promise<void>;
  registerSubjectContext(context: SemanticExecutionSubjectContext): Promise<void>;
  getSubjectContext(executionId: string): Promise<SemanticExecutionSubjectContext | undefined>;
  claimDueJob(now: Date): Promise<SemanticExtractionJob | undefined>;
  isClaimCurrent(job: SemanticExtractionJob): Promise<boolean>;
  bindExecutionConversation(input: {
    readonly executionId: string;
    readonly conversationRef: MemorySubjectRef;
    readonly now: Date;
  }): Promise<void>;
  touchConversation(input: {
    readonly conversationRef: MemorySubjectRef;
    readonly state: "active" | "running" | "completed";
    readonly now: Date;
  }): Promise<void>;
  readEvidence(executionId: string): Promise<readonly MemoryEvidenceEnvelope[]>;
  readEvidenceForJob(job: SemanticExtractionJob): Promise<readonly MemoryEvidenceEnvelope[]>;
  readOmissionStats(executionId: string): Promise<MemoryEvidenceOmissionStats>;
  readOmissionStatsForJob(job: SemanticExtractionJob): Promise<MemoryEvidenceOmissionStats>;
  hasAppliedJob(job: SemanticExtractionJob): Promise<boolean>;
  completePreviouslyApplied(job: SemanticExtractionJob, now: Date): Promise<void>;
  completeRetained(input: SemanticFactMaterialization): Promise<readonly SemanticFact[]>;
  completeRejected(
    job: SemanticExtractionJob,
    reason: SemanticRejectionReason,
    now: Date,
  ): Promise<void>;
  fail(input: {
    readonly job: SemanticExtractionJob;
    readonly errorCode: string;
    readonly now: Date;
    readonly retry: "transient" | "configuration";
  }): Promise<void>;
  wakeNeedsAttention(now: Date, reason?: "configuration" | "manual"): Promise<void>;
  retryJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  expediteJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  interruptJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<SemanticExtractionJob>;
  deleteJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  listExtractionJobs(): Promise<readonly SemanticExtractionJob[]>;
  maintain(now: Date): Promise<{ readonly expired: number; readonly deleted: number }>;
  deleteExecutionState(executionIds: readonly string[], now?: Date): Promise<void>;
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
  getEvidence(messageId: string): Promise<MemoryEvidenceEnvelope | undefined>;
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
  tightenAccess(
    input: SemanticGovernanceInput & {
      readonly bindings?: SemanticFact["bindings"] | undefined;
      readonly visibility?: SemanticFact["visibility"] | undefined;
    },
  ): Promise<SemanticFact>;
  forget(input: SemanticGovernanceInput): Promise<void>;
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
  const dataPath = join(dataRoot, "facts.sqlite");
  const statePath = join(stateRoot, "jobs.sqlite");
  const data = new DatabaseSync(dataPath);
  const state = new DatabaseSync(statePath);
  try {
    await withFileLock(`${dataPath}.migration.lock`, async () => {
      if (readDatabaseVersion(data) === 0) {
        assertFreshSqliteDatabase(data, "pragma.memory-semantic-store");
      } else {
        await runAdjacentSqliteMigrations({
          database: data,
          databasePath: dataPath,
          family: "pragma.memory-semantic-store",
          targetVersion: 3,
          migrations: SEMANTIC_DATA_STORAGE_MIGRATIONS,
        });
      }
      initializeData(data);
    });
    await withFileLock(`${statePath}.migration.lock`, async () => {
      if (readDatabaseVersion(state) === 0) {
        assertFreshSqliteDatabase(state, "pragma.memory-semantic-jobs");
      } else {
        await runAdjacentSqliteMigrations({
          database: state,
          databasePath: statePath,
          family: "pragma.memory-semantic-jobs",
          targetVersion: 3,
          migrations: SEMANTIC_JOB_STORAGE_MIGRATIONS,
        });
      }
      initializeState(state);
    });
  } catch (error) {
    tryClose(data);
    tryClose(state);
    throw error;
  }

  const writeJob = (job: SemanticExtractionJob): void => {
    state
      .prepare(
        `INSERT INTO jobs(id, conversation_key, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET conversation_key=excluded.conversation_key,
           execution_id=excluded.execution_id, terminal_message_id=excluded.terminal_message_id,
           status=excluded.status, retry_at=excluded.retry_at,
           lease_until=excluded.lease_until, job_json=excluded.job_json`,
      )
      .run(
        job.id,
        conversationKey(job.conversationRef),
        job.executionId,
        job.terminalMessageId,
        job.status,
        job.retryAt ?? null,
        job.leaseUntil ?? null,
        JSON.stringify(job),
      );
  };

  const finishJob = (
    job: SemanticExtractionJob,
    completion: "retained" | "rejected",
    now: Date,
  ): void => {
    const completedAt = now.toISOString();
    const finished = SemanticExtractionJobSchema.parse({
      ...job,
      revision: job.revision + 1,
      status: "completed",
      completion,
      retryAt: undefined,
      leaseUntil: undefined,
      lastErrorCode: undefined,
      completedAt,
      updatedAt: completedAt,
    });
    writeJob(finished);
    const deleteEvidence = state.prepare("DELETE FROM evidence WHERE execution_id = ?");
    for (const executionId of job.sourceExecutionIds) deleteEvidence.run(executionId);
  };

  const governanceMutation = (
    action: "revise" | "verify" | "invalidate" | "tighten-access",
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
      recomputeConflicts(data, mutable, input.now);
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
        const touched = new Set<string>();
        for (const raw of envelopes) {
          const envelope = MemoryEvidenceEnvelopeSchema.parse(raw);
          if (envelope.correlationId === undefined) continue;
          if (isDeletedExecution(state, envelope.correlationId)) continue;
          touched.add(envelope.correlationId);
          insertEvidence.run(
            envelope.messageId,
            envelope.correlationId,
            envelope.occurredAt,
            JSON.stringify(envelope),
          );
          if (envelope.topic !== "execution.execution.terminal") continue;
          const conversationRef = envelope.conversationRef ?? {
            type: "pragma.execution",
            id: envelope.correlationId,
          };
          const existing = readJobByConversation(state, conversationRef);
          if (existing?.terminalMessageId === envelope.messageId) continue;
          const activity = readConversationActivity(state, conversationRef);
          const sourceExecutionIds = uniqueStrings([
            ...(existing?.sourceExecutionIds ?? []),
            envelope.correlationId,
          ]);
          const eligibleAt =
            activity?.state === "completed"
              ? activity.updatedAt
              : new Date(
                  (activity === undefined
                    ? Date.parse(envelope.occurredAt)
                    : Math.max(Date.parse(envelope.occurredAt), Date.parse(activity.updatedAt))) +
                    DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
                ).toISOString();
          writeJob(
            SemanticExtractionJobSchema.parse({
              schemaVersion: "pragma.memory-semantic-job/v3",
              id: existing?.id ?? semanticJobId(conversationRef),
              revision: (existing?.revision ?? 0) + 1,
              conversationRef,
              sourceExecutionIds,
              sourceUpdatedAt: envelope.occurredAt,
              inputWatermark: envelope.messageId,
              executionId: envelope.correlationId,
              terminalMessageId: envelope.messageId,
              status: activity?.state === "completed" ? "pending" : "waiting_idle",
              attempts: 0,
              totalAttempts: existing?.totalAttempts ?? 0,
              eligibleAt,
              retryAt: eligibleAt,
              updatedAt: envelope.occurredAt,
            }),
          );
          if (activity?.state !== "completed") {
            writeConversationActivity(state, {
              conversationRef,
              state: "active",
              now: new Date(envelope.occurredAt),
            });
          }
        }
        for (const executionId of touched) compactEvidence(state, executionId);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async registerSubjectContext(raw) {
      const context = SemanticExecutionSubjectContextSchema.parse(raw);
      if (isDeletedExecution(state, context.executionId)) return;
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
            revision: job.revision + 1,
            status:
              job.eligibleAt !== undefined &&
              Date.parse(job.eligibleAt) > Date.parse(context.registeredAt)
                ? "waiting_idle"
                : "pending",
            attempts: 0,
            retryAt:
              job.eligibleAt !== undefined &&
              Date.parse(job.eligibleAt) > Date.parse(context.registeredAt)
                ? job.eligibleAt
                : context.registeredAt,
            lastErrorCode: undefined,
            failureClass: undefined,
            attentionSince: undefined,
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
            `SELECT job.job_json AS jobJson FROM jobs AS job
             WHERE (((job.status = 'pending' AND (job.retry_at IS NULL OR job.retry_at <= ?))
                OR (job.status = 'waiting_idle' AND job.retry_at <= ?))
                OR (job.status = 'running' AND job.lease_until <= ?))
               AND NOT EXISTS (
                 SELECT 1 FROM conversation_activity AS activity
                 WHERE activity.conversation_key = job.conversation_key
                   AND activity.state = 'running'
               )
             ORDER BY job.retry_at IS NOT NULL, job.retry_at, job.id LIMIT 1`,
          )
          .get(now.toISOString(), now.toISOString(), now.toISOString()) as unknown as
          { readonly jobJson: string } | undefined;
        if (row === undefined) {
          state.exec("COMMIT;");
          return undefined;
        }
        const current = SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson));
        const claimed = SemanticExtractionJobSchema.parse({
          ...current,
          revision: current.revision + 1,
          status: "running",
          attempts: current.attempts + 1,
          totalAttempts: current.totalAttempts + 1,
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

    async isClaimCurrent(job) {
      return isCurrentRunningJob(state, job);
    },

    async bindExecutionConversation(input) {
      state.exec("BEGIN IMMEDIATE;");
      try {
        bindExecutionConversationJob(state, writeJob, input, semanticJobId);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async touchConversation(input) {
      state.exec("BEGIN IMMEDIATE;");
      try {
        writeConversationActivity(state, input);
        const current = readJobByConversation(state, input.conversationRef);
        if (current !== undefined && current.status !== "expired") {
          const eligibleAt =
            input.state === "completed"
              ? input.now.toISOString()
              : new Date(
                  input.now.getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
                ).toISOString();
          writeJob(
            SemanticExtractionJobSchema.parse({
              ...current,
              revision: current.revision + 1,
              status: input.state === "completed" ? "pending" : "waiting_idle",
              attempts: 0,
              retryAt: eligibleAt,
              eligibleAt,
              leaseUntil: undefined,
              completedAt: undefined,
              completion: undefined,
              updatedAt: input.now.toISOString(),
            }),
          );
        }
        state.exec("COMMIT;");
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

    async readEvidenceForJob(job) {
      const pages = job.sourceExecutionIds.map((id) => {
        const rows = state
          .prepare(
            "SELECT envelope_json AS envelopeJson FROM evidence WHERE execution_id = ? ORDER BY occurred_at, message_id",
          )
          .all(id) as unknown as readonly { envelopeJson: string }[];
        return rows.map((row) => MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson)));
      });
      return [...new Map(pages.flat().map((item) => [item.messageId, item])).values()]
        .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt))
        .slice(-2_000);
    },

    async readOmissionStats(executionId) {
      return readOmissionStats(state, executionId);
    },

    async readOmissionStatsForJob(job) {
      return job.sourceExecutionIds.reduce(
        (stats, executionId) =>
          mergeMemoryEvidenceOmissionStats(stats, readOmissionStats(state, executionId)),
        EMPTY_MEMORY_EVIDENCE_OMISSION_STATS,
      );
    },

    async hasAppliedJob(job) {
      return (
        data
          .prepare("SELECT 1 AS found FROM applied_jobs WHERE job_id = ? AND input_watermark = ?")
          .get(job.id, job.inputWatermark) !== undefined
      );
    },

    async completePreviouslyApplied(job, now) {
      if (isDeletedExecution(state, job.executionId)) return;
      state.exec("BEGIN IMMEDIATE;");
      try {
        if (isCurrentRunningJob(state, job)) finishJob(job, "retained", now);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async completeRetained(input) {
      if (isDeletedExecution(state, input.job.executionId)) return [];
      if (!isCurrentRunningJob(state, input.job)) return [];
      const evidenceById = new Map(input.evidence.map((item) => [item.messageId, item]));
      const touched = new Set<string>();
      data.exec("BEGIN IMMEDIATE;");
      try {
        if (
          data
            .prepare("SELECT 1 FROM applied_jobs WHERE job_id = ? AND input_watermark = ?")
            .get(input.job.id, input.job.inputWatermark)
        ) {
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
            if (existing === undefined && hasSemanticTombstone(data, id)) continue;
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
          recomputeConflicts(data, touched, input.now);
          data
            .prepare(
              "INSERT INTO applied_jobs(job_id, input_watermark, terminal_message_id, applied_at) VALUES (?, ?, ?, ?)",
            )
            .run(
              input.job.id,
              input.job.inputWatermark,
              input.job.terminalMessageId,
              input.now.toISOString(),
            );
          data.exec("COMMIT;");
        }
      } catch (error) {
        rollback(data);
        throw error;
      }
      state.exec("BEGIN IMMEDIATE;");
      try {
        finishJob(input.job, "retained", input.now);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
      return [...touched].map((id) => readRequiredFact(data, id));
    },

    async completeRejected(job, reason, now) {
      if (isDeletedExecution(state, job.executionId)) return;
      if (!isCurrentRunningJob(state, job)) return;
      state.exec("BEGIN IMMEDIATE;");
      try {
        finishJob(job, "rejected", now);
        incrementCounter(state, "rejected_total");
        incrementCounter(state, `rejected_${reason.replaceAll("-", "_")}`);
        state.exec("COMMIT;");
      } catch (error) {
        rollback(state);
        throw error;
      }
    },

    async fail(input) {
      if (isDeletedExecution(state, input.job.executionId)) return;
      if (!isCurrentRunningJob(state, input.job)) return;
      const needsAttention = input.retry === "configuration" || input.job.attempts >= 3;
      const delay = input.job.attempts <= 1 ? 60_000 : 5 * 60_000;
      writeJob(
        SemanticExtractionJobSchema.parse({
          ...input.job,
          revision: input.job.revision + 1,
          status: needsAttention ? "needs_attention" : "pending",
          leaseUntil: undefined,
          ...(needsAttention
            ? { retryAt: undefined }
            : { retryAt: new Date(input.now.getTime() + delay).toISOString() }),
          lastErrorCode: input.errorCode,
          ...(needsAttention
            ? {
                failureClass:
                  input.retry === "configuration" ? "configuration" : "transient-exhausted",
                attentionSince: input.job.attentionSince ?? input.now.toISOString(),
              }
            : {}),
          updatedAt: input.now.toISOString(),
        }),
      );
    },

    async wakeNeedsAttention(now, reason = "configuration") {
      const rows = state
        .prepare("SELECT job_json AS jobJson FROM jobs WHERE status = 'needs_attention'")
        .all() as unknown as readonly { readonly jobJson: string }[];
      for (const row of rows) {
        const job = parseExtractionJobJson(row.jobJson, SemanticExtractionJobSchema);
        if (job === undefined) continue;
        if (reason === "configuration" && job.failureClass !== "configuration") continue;
        writeJob(
          SemanticExtractionJobSchema.parse({
            ...job,
            revision: job.revision + 1,
            status:
              job.eligibleAt !== undefined && Date.parse(job.eligibleAt) > now.getTime()
                ? "waiting_idle"
                : "pending",
            attempts: 0,
            retryAt:
              job.eligibleAt !== undefined && Date.parse(job.eligibleAt) > now.getTime()
                ? job.eligibleAt
                : now.toISOString(),
            lastErrorCode: undefined,
            failureClass: undefined,
            attentionSince: undefined,
            updatedAt: now.toISOString(),
          }),
        );
      }
    },

    async retryJob(input) {
      const job = readJob(state, input.id);
      if (job === undefined) throw new Error("memory_extraction_job_not_found");
      if (job.revision !== input.expectedRevision) {
        throw new Error("memory_extraction_job_revision_conflict");
      }
      if (job.status !== "needs_attention") throw new Error("memory_extraction_job_not_retryable");
      writeJob(
        SemanticExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status:
            job.eligibleAt !== undefined && Date.parse(job.eligibleAt) > input.now.getTime()
              ? "waiting_idle"
              : "pending",
          attempts: 0,
          retryAt:
            job.eligibleAt !== undefined && Date.parse(job.eligibleAt) > input.now.getTime()
              ? job.eligibleAt
              : input.now.toISOString(),
          lastErrorCode: undefined,
          failureClass: undefined,
          attentionSince: undefined,
          updatedAt: input.now.toISOString(),
        }),
      );
    },

    async expediteJob(input) {
      const job = readJob(state, input.id);
      assertManageableJob(job, input.expectedRevision, ["waiting_idle", "pending"]);
      const timestamp = input.now.toISOString();
      writeJob(
        SemanticExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status: "pending",
          eligibleAt: timestamp,
          retryAt: timestamp,
          leaseUntil: undefined,
          updatedAt: timestamp,
        }),
      );
    },

    async interruptJob(input) {
      const job = readJob(state, input.id);
      assertManageableJob(job, input.expectedRevision, ["running"]);
      const timestamp = input.now.toISOString();
      const eligibleAt = new Date(
        input.now.getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
      ).toISOString();
      const interrupted = SemanticExtractionJobSchema.parse({
        ...job,
        revision: job.revision + 1,
        status: "waiting_idle",
        attempts: 0,
        eligibleAt,
        retryAt: eligibleAt,
        leaseUntil: undefined,
        lastErrorCode: undefined,
        failureClass: undefined,
        attentionSince: undefined,
        updatedAt: timestamp,
      });
      writeJob(interrupted);
      return interrupted;
    },

    async deleteJob(input) {
      const job = readJob(state, input.id);
      assertManageableJob(job, input.expectedRevision, ["needs_attention"]);
      deleteExtractionJobState(state, job, input.now);
    },

    async listExtractionJobs() {
      return readJobRows(state);
    },

    async maintain(now) {
      const result = maintainJobs(state, now);
      const cutoff = now.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs;
      await Promise.all([
        ...SEMANTIC_DATA_STORAGE_MIGRATIONS.map((step) =>
          removeExpiredSqliteMigrationBackup(dataPath, step.fromVersion, cutoff),
        ),
        ...SEMANTIC_JOB_STORAGE_MIGRATIONS.map((step) =>
          removeExpiredSqliteMigrationBackup(statePath, step.fromVersion, cutoff),
        ),
      ]);
      return result;
    },

    async deleteExecutionState(executionIds, now = new Date()) {
      deleteExecutionState(state, executionIds, now);
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

    async getEvidence(messageId) {
      const row = data
        .prepare("SELECT envelope_json AS envelopeJson FROM evidence WHERE message_id = ?")
        .get(messageId) as { readonly envelopeJson: string } | undefined;
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

    async tightenAccess(input) {
      return governanceMutation("tighten-access", input, (current) => ({
        ...current,
        ...(input.bindings === undefined
          ? {}
          : { bindings: assertMemoryBindingsTightened(current.bindings, input.bindings) }),
        ...(input.visibility === undefined
          ? {}
          : {
              visibility: assertMemoryVisibilityTightened(current.visibility, input.visibility),
            }),
        revision: current.revision + 1,
        supersedes: appendRevisionRef(current.supersedes, current.id, current.revision),
        updatedAt: input.now.toISOString(),
      }));
    },

    async forget(input) {
      data.exec("BEGIN IMMEDIATE;");
      try {
        const current = readFact(data, input.id);
        if (current === undefined) throw new Error("semantic_fact_not_found");
        if (current.revision !== input.expectedRevision) {
          throw revisionConflict(input.expectedRevision, current.revision);
        }
        data.prepare("DELETE FROM fact_evidence WHERE fact_id = ?").run(input.id);
        data.prepare("DELETE FROM fact_revisions WHERE fact_id = ?").run(input.id);
        data.prepare("DELETE FROM governance_events WHERE fact_id = ?").run(input.id);
        data.prepare("DELETE FROM current_facts WHERE id = ?").run(input.id);
        data
          .prepare(
            "DELETE FROM evidence WHERE message_id NOT IN (SELECT evidence_id FROM fact_evidence)",
          )
          .run();
        data
          .prepare(
            "INSERT INTO tombstones(id, last_revision, forgotten_at, tombstone_json) VALUES (?, ?, ?, ?)",
          )
          .run(
            input.id,
            current.revision,
            input.now.toISOString(),
            JSON.stringify(createMemoryTombstone("semantic", current.id, current.revision, input)),
          );
        recomputeConflicts(data, new Set(), input.now);
        data.exec("COMMIT;");
      } catch (error) {
        rollback(data);
        throw error;
      }
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
      const attentionRows = state
        .prepare("SELECT job_json AS jobJson FROM jobs WHERE status = 'needs_attention'")
        .all() as unknown as readonly { readonly jobJson: string }[];
      const lastErrorCode = latestExtractionJobErrorCode(
        attentionRows,
        SemanticExtractionJobSchema,
        "semantic_extraction_job_invalid",
      );
      return {
        facts: facts.count,
        pending: (byStatus.get("pending") ?? 0) + (byStatus.get("waiting_idle") ?? 0),
        running: byStatus.get("running") ?? 0,
        needsAttention: byStatus.get("needs_attention") ?? 0,
        expired: byStatus.get("expired") ?? 0,
        ...inspectEvidenceState(state),
        rejected: counters.get("rejected_total") ?? 0,
        ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
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

function semanticJobId(conversationRef: MemorySubjectRef): string {
  return `semantic-${createHash("sha256").update(conversationKey(conversationRef)).digest("hex").slice(0, 24)}`;
}

function conversationKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function initializeData(database: DatabaseSync): void {
  const version = readDatabaseVersion(database);
  if (version > 3) {
    database.close();
    throw new Error(`unsupported-state-version:pragma.memory-semantic-store/v${version}`);
  }
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
      job_id TEXT NOT NULL,
      input_watermark TEXT NOT NULL,
      terminal_message_id TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (job_id, input_watermark)
    );
    CREATE TABLE IF NOT EXISTS governance_events (
      id TEXT PRIMARY KEY,
      fact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tombstones (
      id TEXT PRIMARY KEY,
      last_revision INTEGER NOT NULL,
      forgotten_at TEXT NOT NULL,
      tombstone_json TEXT NOT NULL
    );
  `);
  if (version !== 0 && version !== 3) {
    throw new Error(`missing-adjacent-migration:pragma.memory-semantic-store/v${version}`);
  }
  database.exec("PRAGMA user_version = 3;");
}

function initializeState(database: DatabaseSync): void {
  assertVersion(database, "pragma.memory-semantic-jobs", 3);
  const version = readDatabaseVersion(database);
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
      conversation_key TEXT NOT NULL UNIQUE,
      execution_id TEXT NOT NULL,
      terminal_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_at TEXT,
      lease_until TEXT,
      job_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS semantic_jobs_due ON jobs(status, retry_at, lease_until);
    CREATE TABLE IF NOT EXISTS conversation_activity (
      conversation_key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subject_contexts (
      execution_id TEXT PRIMARY KEY,
      context_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_stats (
      execution_id TEXT PRIMARY KEY,
      stats_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_executions (
      execution_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );
  `);
  if (version !== 0 && version !== 3) {
    throw new Error(`missing-adjacent-migration:pragma.memory-semantic-jobs/v${version}`);
  }
  database.exec("PRAGMA user_version = 3;");
}

function assertVersion(database: DatabaseSync, family: string, current: number): void {
  const version = readDatabaseVersion(database);
  if (version > current) {
    database.close();
    throw new Error(`unsupported-state-version:${family}/v${version}`);
  }
}

function readDatabaseVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  return row.user_version;
}

function readJob(database: DatabaseSync, id: string): SemanticExtractionJob | undefined {
  const row = database.prepare("SELECT job_json AS jobJson FROM jobs WHERE id = ?").get(id) as
    { readonly jobJson: string } | undefined;
  return row === undefined ? undefined : SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson));
}

function readJobByConversation(
  database: DatabaseSync,
  conversationRef: MemorySubjectRef,
): SemanticExtractionJob | undefined {
  const row = database
    .prepare("SELECT job_json AS jobJson FROM jobs WHERE conversation_key = ?")
    .get(conversationKey(conversationRef)) as { readonly jobJson: string } | undefined;
  return row === undefined ? undefined : SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson));
}

function bindExecutionConversationJob(
  database: DatabaseSync,
  writeJob: (job: SemanticExtractionJob) => void,
  input: {
    readonly executionId: string;
    readonly conversationRef: MemorySubjectRef;
    readonly now: Date;
  },
  createJobId: (conversationRef: MemorySubjectRef) => string,
): void {
  const fallback = database
    .prepare("SELECT job_json AS jobJson FROM jobs WHERE execution_id = ?")
    .get(input.executionId) as { readonly jobJson: string } | undefined;
  if (fallback === undefined) return;
  const job = SemanticExtractionJobSchema.parse(JSON.parse(fallback.jobJson));
  if (
    job.conversationRef.type === input.conversationRef.type &&
    job.conversationRef.id === input.conversationRef.id
  ) {
    return;
  }
  if (
    job.conversationRef.type !== "pragma.execution" ||
    job.conversationRef.id !== input.executionId
  ) {
    return;
  }
  const existing = readJobByConversation(database, input.conversationRef);
  database.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
  database
    .prepare("DELETE FROM conversation_activity WHERE conversation_key = ?")
    .run(conversationKey(job.conversationRef));
  const latest =
    existing === undefined || job.sourceUpdatedAt >= existing.sourceUpdatedAt ? job : existing;
  writeJob(
    SemanticExtractionJobSchema.parse({
      ...latest,
      id: existing?.id ?? createJobId(input.conversationRef),
      revision: Math.max(existing?.revision ?? 0, job.revision) + 1,
      conversationRef: input.conversationRef,
      sourceExecutionIds: uniqueStrings([
        ...(existing?.sourceExecutionIds ?? []),
        ...job.sourceExecutionIds,
      ]),
      totalAttempts: (existing?.totalAttempts ?? 0) + job.totalAttempts,
      updatedAt: input.now.toISOString(),
    }),
  );
}

function writeConversationActivity(
  database: DatabaseSync,
  input: {
    readonly conversationRef: MemorySubjectRef;
    readonly state: "active" | "running" | "completed";
    readonly now: Date;
  },
): void {
  database
    .prepare(
      `INSERT INTO conversation_activity(conversation_key, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(conversation_key) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`,
    )
    .run(conversationKey(input.conversationRef), input.state, input.now.toISOString());
}

function readConversationActivity(
  database: DatabaseSync,
  conversationRef: MemorySubjectRef,
): { readonly state: "active" | "running" | "completed"; readonly updatedAt: string } | undefined {
  return database
    .prepare(
      "SELECT state, updated_at AS updatedAt FROM conversation_activity WHERE conversation_key = ?",
    )
    .get(conversationKey(conversationRef)) as
    { readonly state: "active" | "running" | "completed"; readonly updatedAt: string } | undefined;
}

function isCurrentRunningJob(database: DatabaseSync, claimed: SemanticExtractionJob): boolean {
  const current = readJob(database, claimed.id);
  return current?.status === "running" && current.revision === claimed.revision;
}

function readJobRows(database: DatabaseSync): SemanticExtractionJob[] {
  const rows = database
    .prepare("SELECT job_json AS jobJson FROM jobs ORDER BY rowid DESC")
    .all() as unknown as readonly { readonly jobJson: string }[];
  return rows.map((row) => SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson)));
}

function compactEvidence(database: DatabaseSync, executionId: string): void {
  const rows = database
    .prepare(
      "SELECT envelope_json AS envelopeJson FROM evidence WHERE execution_id = ? ORDER BY occurred_at, message_id",
    )
    .all(executionId) as unknown as readonly { readonly envelopeJson: string }[];
  const evidence = rows.map((row) =>
    MemoryEvidenceEnvelopeSchema.parse(JSON.parse(row.envelopeJson)),
  );
  const selection = selectBoundedMemoryEvidence(evidence, {
    maxRecords: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxRecordsPerExecution,
    maxBytes: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxBytesPerExecution,
  });
  if (selection.omitted.length === 0) return;
  const remove = database.prepare("DELETE FROM evidence WHERE message_id = ?");
  for (const envelope of selection.omitted) remove.run(envelope.messageId);
  const stats = mergeMemoryEvidenceOmissionStats(
    readOmissionStats(database, executionId),
    selection.omittedStats,
  );
  database
    .prepare(
      `INSERT INTO capture_stats(execution_id, stats_json) VALUES (?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET stats_json=excluded.stats_json`,
    )
    .run(executionId, JSON.stringify(stats));
}

function readOmissionStats(
  database: DatabaseSync,
  executionId: string,
): MemoryEvidenceOmissionStats {
  const row = database
    .prepare("SELECT stats_json AS statsJson FROM capture_stats WHERE execution_id = ?")
    .get(executionId) as { readonly statsJson: string } | undefined;
  return row === undefined
    ? EMPTY_MEMORY_EVIDENCE_OMISSION_STATS
    : MemoryEvidenceOmissionStatsSchema.parse(JSON.parse(row.statsJson));
}

function inspectEvidenceState(database: DatabaseSync): {
  readonly evidenceRecords: number;
  readonly evidenceBytes: number;
  readonly truncatedExecutions: number;
} {
  const evidence = database
    .prepare(
      "SELECT COUNT(*) AS records, COALESCE(SUM(length(CAST(envelope_json AS BLOB))), 0) AS bytes FROM evidence",
    )
    .get() as unknown as { readonly records: number; readonly bytes: number };
  const truncated = database
    .prepare("SELECT COUNT(*) AS count FROM capture_stats")
    .get() as unknown as { readonly count: number };
  return {
    evidenceRecords: evidence.records,
    evidenceBytes: evidence.bytes,
    truncatedExecutions: truncated.count,
  };
}

function maintainJobs(
  database: DatabaseSync,
  now: Date,
): { readonly expired: number; readonly deleted: number } {
  const timestamp = now.getTime();
  let expired = 0;
  let deleted = 0;
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (const job of readJobRows(database)) {
      if (
        job.status === "needs_attention" &&
        job.attentionSince !== undefined &&
        timestamp - Date.parse(job.attentionSince) >=
          DEFAULT_MEMORY_STORAGE_POLICY.failedPayloadRetentionMs
      ) {
        const next = SemanticExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status: "expired",
          expiredAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
        const deleteEvidence = database.prepare("DELETE FROM evidence WHERE execution_id = ?");
        const deleteStats = database.prepare("DELETE FROM capture_stats WHERE execution_id = ?");
        const deleteSubjects = database.prepare(
          "DELETE FROM subject_contexts WHERE execution_id = ?",
        );
        for (const executionId of job.sourceExecutionIds) {
          deleteEvidence.run(executionId);
          deleteStats.run(executionId);
          deleteSubjects.run(executionId);
        }
        database
          .prepare("UPDATE jobs SET status = 'expired', job_json = ? WHERE id = ?")
          .run(JSON.stringify(next), next.id);
        expired += 1;
        continue;
      }
      const terminalAt = job.status === "completed" ? job.completedAt : job.expiredAt;
      const retention =
        job.status === "completed"
          ? DEFAULT_MEMORY_STORAGE_POLICY.jobRecordRetentionMs
          : DEFAULT_MEMORY_STORAGE_POLICY.expiredDiagnosticRetentionMs;
      if (
        terminalAt !== undefined &&
        ["completed", "expired"].includes(job.status) &&
        timestamp - Date.parse(terminalAt) >= retention
      ) {
        database.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
        const deleteStats = database.prepare("DELETE FROM capture_stats WHERE execution_id = ?");
        const deleteSubjects = database.prepare(
          "DELETE FROM subject_contexts WHERE execution_id = ?",
        );
        for (const executionId of job.sourceExecutionIds) {
          deleteStats.run(executionId);
          deleteSubjects.run(executionId);
        }
        deleted += 1;
      }
    }
    database
      .prepare("DELETE FROM deleted_executions WHERE deleted_at <= ?")
      .run(
        new Date(timestamp - DEFAULT_MEMORY_STORAGE_POLICY.failedPayloadRetentionMs).toISOString(),
      );
    database.exec("COMMIT;");
    return { expired, deleted };
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function deleteExecutionState(
  database: DatabaseSync,
  executionIds: readonly string[],
  now: Date,
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const targets = new Set(executionIds);
    const deleteJob = database.prepare("DELETE FROM jobs WHERE id = ?");
    const deleteActivity = database.prepare(
      "DELETE FROM conversation_activity WHERE conversation_key = ?",
    );
    for (const job of readJobRows(database)) {
      if (!job.sourceExecutionIds.some((executionId) => targets.has(executionId))) continue;
      deleteJob.run(job.id);
      deleteActivity.run(conversationKey(job.conversationRef));
    }
    const markDeleted = database.prepare(
      `INSERT INTO deleted_executions(execution_id, deleted_at) VALUES (?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET deleted_at=excluded.deleted_at`,
    );
    const deleteEvidence = database.prepare("DELETE FROM evidence WHERE execution_id = ?");
    const deleteStats = database.prepare("DELETE FROM capture_stats WHERE execution_id = ?");
    const deleteSubjects = database.prepare("DELETE FROM subject_contexts WHERE execution_id = ?");
    for (const executionId of new Set(executionIds)) {
      markDeleted.run(executionId, now.toISOString());
      deleteEvidence.run(executionId);
      deleteStats.run(executionId);
      deleteSubjects.run(executionId);
    }
    database.exec("COMMIT;");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function assertManageableJob(
  job: SemanticExtractionJob | undefined,
  expectedRevision: number,
  statuses: readonly SemanticExtractionJob["status"][],
): asserts job is SemanticExtractionJob {
  if (job === undefined) throw new Error("memory_extraction_job_not_found");
  if (job.revision !== expectedRevision) {
    throw new Error("memory_extraction_job_revision_conflict");
  }
  if (!statuses.includes(job.status)) throw new Error("memory_extraction_job_action_invalid");
}

function deleteExtractionJobState(
  database: DatabaseSync,
  job: SemanticExtractionJob,
  now: Date,
): void {
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    database
      .prepare("DELETE FROM conversation_activity WHERE conversation_key = ?")
      .run(conversationKey(job.conversationRef));
    const markDeleted = database.prepare(
      `INSERT INTO deleted_executions(execution_id, deleted_at) VALUES (?, ?)
       ON CONFLICT(execution_id) DO UPDATE SET deleted_at=excluded.deleted_at`,
    );
    const deleteEvidence = database.prepare("DELETE FROM evidence WHERE execution_id = ?");
    const deleteStats = database.prepare("DELETE FROM capture_stats WHERE execution_id = ?");
    const deleteSubjects = database.prepare("DELETE FROM subject_contexts WHERE execution_id = ?");
    for (const executionId of job.sourceExecutionIds) {
      markDeleted.run(executionId, now.toISOString());
      deleteEvidence.run(executionId);
      deleteStats.run(executionId);
      deleteSubjects.run(executionId);
    }
    database.exec("COMMIT;");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function isDeletedExecution(database: DatabaseSync, executionId: string): boolean {
  return (
    database
      .prepare("SELECT 1 AS found FROM deleted_executions WHERE execution_id = ?")
      .get(executionId) !== undefined
  );
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

function recomputeConflicts(database: DatabaseSync, mutable: ReadonlySet<string>, now: Date): void {
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
        updatedAt: now.toISOString(),
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
  const principals = uniqueRefs([scope.rootRef, scope.expertRef, ...(scope.principalRefs ?? [])]);
  const principalClauses = principals.map(
    () =>
      `(json_extract(principal.value, '$.type') = ?
        AND json_extract(principal.value, '$.id') = ?)`,
  );
  return {
    sql: `json_extract(${alias}.record_json, '$.status') = 'active'
      AND (json_extract(${alias}.record_json, '$.expiresAt') IS NULL
        OR json_extract(${alias}.record_json, '$.expiresAt') > ?)
      AND (${clauses.join(" OR ")})
      AND (json_extract(${alias}.record_json, '$.visibility.mode') != 'restricted'
        OR EXISTS (
          SELECT 1 FROM json_each(${alias}.record_json, '$.visibility.principals') AS principal
          WHERE ${principalClauses.length === 0 ? "0" : principalClauses.join(" OR ")}
        ))`,
    parameters: [
      now.toISOString(),
      ...refs.flatMap((ref) => [ref.type, ref.id]),
      ...principals.flatMap((ref) => [ref.type, ref.id]),
    ],
  };
}

function insertGovernanceEvent(database: DatabaseSync, event: SemanticGovernanceEvent): void {
  database
    .prepare("INSERT INTO governance_events(id, fact_id, revision, event_json) VALUES (?, ?, ?, ?)")
    .run(event.id, event.factId, event.revision, JSON.stringify(event));
}

function hasSemanticTombstone(database: DatabaseSync, id: string): boolean {
  return database.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(id) !== undefined;
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
