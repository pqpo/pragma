import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  KnowledgeCandidateSchema,
  KnowledgeExtractionJobSchema,
  KnowledgeGovernanceEventSchema,
  KnowledgeSchema,
  KnowledgeShareSchema,
  type Knowledge,
  type KnowledgeCandidate,
  type KnowledgeContent,
  type KnowledgeExtractionCandidate,
  type KnowledgeExtractionJob,
  type KnowledgeExtractorProvenance,
  type KnowledgeShare,
  type KnowledgeSourceSnapshot,
  type MemoryRevisionBinding,
  type MemorySubjectRef,
  type MemoryVisibilityPolicy,
} from "@pragma/shared";

import {
  assertMemoryBindingsTightened,
  assertMemoryVisibilityTightened,
} from "../governance/access-governance.ts";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import { assertFreshSqliteDatabase } from "../storage/sqlite-migration-backup.ts";
import { assertKnowledgeShareDigest } from "./share.ts";

const MODULE_ID = "pragma.memory.knowledge";
const MAX_PENDING_CANDIDATES = 1_000;
const MAX_PENDING_CANDIDATE_BYTES = 64 * 1024 * 1024;
const CANDIDATE_BODY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface KnowledgePublicationInput {
  readonly candidateId: string;
  readonly expectedRevision: number;
  readonly actorRef: MemorySubjectRef;
  readonly reason: string;
  readonly bindings: readonly MemoryRevisionBinding[];
  readonly visibility: MemoryVisibilityPolicy;
  readonly now: Date;
}

export interface KnowledgeStoreDiagnostic {
  readonly knowledge: number;
  readonly pending: number;
  readonly running: number;
  readonly needsAttention: number;
  readonly rejected: number;
  readonly candidateBytes: number;
  readonly lastErrorCode?: string | undefined;
}

export interface KnowledgeMemoryStore {
  schedule(input: {
    readonly rootRef: MemorySubjectRef;
    readonly sourceDigest: string;
    readonly now: Date;
  }): Promise<KnowledgeExtractionJob | undefined>;
  claimDueJob(now: Date): Promise<KnowledgeExtractionJob | undefined>;
  isClaimCurrent(job: KnowledgeExtractionJob): Promise<boolean>;
  completeCandidates(input: {
    readonly job: KnowledgeExtractionJob;
    readonly candidates: readonly KnowledgeExtractionCandidate[];
    readonly sources: readonly KnowledgeSourceSnapshot[];
    readonly provenance: KnowledgeExtractorProvenance;
    readonly now: Date;
  }): Promise<readonly KnowledgeCandidate[]>;
  completeRejected(job: KnowledgeExtractionJob, now: Date): Promise<void>;
  fail(input: {
    readonly job: KnowledgeExtractionJob;
    readonly errorCode: string;
    readonly retry: "configuration" | "transient" | "capacity";
    readonly now: Date;
  }): Promise<void>;
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
  }): Promise<KnowledgeExtractionJob>;
  deleteJob(input: { readonly id: string; readonly expectedRevision: number }): Promise<void>;
  wakeNeedsAttention(now: Date, reason?: "configuration" | "manual"): Promise<void>;
  listJobs(): Promise<readonly KnowledgeExtractionJob[]>;
  listCandidates(state?: KnowledgeCandidate["state"]): Promise<readonly KnowledgeCandidate[]>;
  getCandidate(id: string): Promise<KnowledgeCandidate | undefined>;
  updateCandidate(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly content: KnowledgeContent;
    readonly now: Date;
  }): Promise<KnowledgeCandidate>;
  rejectCandidate(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
    readonly now: Date;
  }): Promise<KnowledgeCandidate>;
  publishCandidate(input: KnowledgePublicationInput): Promise<Knowledge>;
  createSuccessor(input: {
    readonly knowledgeId: string;
    readonly expectedRevision: number;
    readonly content: KnowledgeContent;
    readonly actorRef: MemorySubjectRef;
    readonly now: Date;
  }): Promise<KnowledgeCandidate>;
  list(): Promise<readonly Knowledge[]>;
  get(id: string, revision?: number): Promise<Knowledge | undefined>;
  history(id: string): Promise<readonly Knowledge[]>;
  listForRecall(scope: MemoryRecallScope): Promise<readonly Knowledge[]>;
  searchForRecall(
    scope: MemoryRecallScope,
    query: string,
    limit: number,
  ): Promise<readonly Knowledge[]>;
  getForRecall(
    scope: MemoryRecallScope,
    id: string,
    revision?: number,
  ): Promise<Knowledge | undefined>;
  tightenAccess(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly actorRef: MemorySubjectRef;
    readonly reason: string;
    readonly bindings?: readonly MemoryRevisionBinding[] | undefined;
    readonly visibility?: MemoryVisibilityPolicy | undefined;
    readonly now: Date;
  }): Promise<Knowledge>;
  withdraw(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly actorRef: MemorySubjectRef;
    readonly reason: string;
    readonly now: Date;
  }): Promise<Knowledge>;
  listExportable(input: {
    readonly projectRef: MemorySubjectRef;
    readonly refs: readonly { readonly id: string; readonly revision: number }[];
  }): Promise<readonly Knowledge[]>;
  importShares(input: {
    readonly shares: readonly KnowledgeShare[];
    readonly mapRef: (ref: MemorySubjectRef) => MemorySubjectRef | undefined;
    readonly actorRef: MemorySubjectRef;
    readonly now: Date;
  }): Promise<readonly Knowledge[]>;
  maintain(now: Date): Promise<{ readonly purgedCandidateBodies: number }>;
  inspect(): Promise<KnowledgeStoreDiagnostic>;
  close(): void;
}

export async function createKnowledgeMemoryStore(
  options: { readonly pragmaHome?: string | undefined } = {},
): Promise<KnowledgeMemoryStore> {
  const paths = new PragmaPaths(options);
  const dataRoot = paths.memoryModuleDataRoot(MODULE_ID);
  const stateRoot = paths.memoryModuleStateRoot(MODULE_ID);
  await Promise.all([
    mkdir(dataRoot, { recursive: true, mode: 0o700 }),
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
  ]);
  const databasePath = join(dataRoot, "knowledge.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    await withFileLock(`${databasePath}.migration.lock`, async () => {
      assertFreshOrCurrent(database);
      initialize(database);
    });
  } catch (error) {
    database.close();
    throw error;
  }

  const writeJob = (job: KnowledgeExtractionJob): void => {
    database
      .prepare(
        `INSERT INTO jobs(id, root_key, source_digest, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, retry_at=excluded.retry_at,
           lease_until=excluded.lease_until, job_json=excluded.job_json`,
      )
      .run(
        job.id,
        refKey(job.rootRef),
        job.sourceDigest,
        job.status,
        job.retryAt ?? null,
        job.leaseUntil ?? null,
        JSON.stringify(job),
      );
  };

  const writeCandidate = (candidate: KnowledgeCandidate): void => {
    database.prepare("UPDATE candidates SET is_current=0 WHERE id=?").run(candidate.id);
    database
      .prepare(
        `INSERT INTO candidates(id, revision, root_key, normalized_key, source_digest, state,
          body_bytes, is_current, updated_at, candidate_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.revision,
        refKey(candidate.rootRef),
        candidate.content.normalizedKey,
        candidate.sourceDigest,
        candidate.state,
        Buffer.byteLength(JSON.stringify(candidate)),
        candidate.updatedAt,
        JSON.stringify(candidate),
      );
  };

  const writeKnowledge = (knowledge: Knowledge): void => {
    database.prepare("UPDATE knowledge SET is_current=0 WHERE id=?").run(knowledge.id);
    database
      .prepare(
        `INSERT INTO knowledge(id, revision, root_key, normalized_key, status, is_current,
          source_origin_key, knowledge_json) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        knowledge.id,
        knowledge.revision,
        refKey(knowledge.rootRef),
        knowledge.content.normalizedKey,
        knowledge.status,
        knowledge.origin.kind === "bundle-import"
          ? `${knowledge.origin.sourceProjectFingerprint}\0${knowledge.origin.sourceKnowledgeId}`
          : null,
        JSON.stringify(knowledge),
      );
  };

  const store: KnowledgeMemoryStore = {
    async schedule(input) {
      const parsedDigest = assertDigest(input.sourceDigest);
      const rootKey = refKey(input.rootRef);
      const existing = database
        .prepare("SELECT job_json FROM jobs WHERE root_key=? AND source_digest=?")
        .get(rootKey, parsedDigest) as { job_json: string } | undefined;
      if (existing !== undefined) return undefined;
      const timestamp = input.now.toISOString();
      const job = KnowledgeExtractionJobSchema.parse({
        schemaVersion: "pragma.memory-knowledge-job/v1",
        id: stableId("knowledge-job", rootKey, parsedDigest),
        revision: 1,
        rootRef: input.rootRef,
        sourceDigest: parsedDigest,
        status: "pending",
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      writeJob(job);
      return job;
    },
    async claimDueJob(now) {
      const row = database
        .prepare(
          `SELECT job_json FROM jobs
           WHERE (status='pending' AND (retry_at IS NULL OR retry_at<=?))
              OR (status='running' AND lease_until<=?)
           ORDER BY rowid LIMIT 1`,
        )
        .get(now.toISOString(), now.toISOString()) as { job_json: string } | undefined;
      if (row === undefined) return undefined;
      const current = parseJob(row.job_json);
      const claimed = KnowledgeExtractionJobSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "running",
        attempts: current.attempts + 1,
        retryAt: undefined,
        leaseUntil: new Date(now.getTime() + 5 * 60_000).toISOString(),
        updatedAt: now.toISOString(),
      });
      writeJob(claimed);
      return claimed;
    },
    async isClaimCurrent(job) {
      const current = readJob(database, job.id);
      return current?.revision === job.revision && current.status === "running";
    },
    async completeCandidates(input) {
      assertCurrentJob(database, input.job);
      const diagnostic = readCandidateCapacity(database);
      const estimated = input.candidates.reduce(
        (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
        0,
      );
      if (
        diagnostic.pending + input.candidates.length > MAX_PENDING_CANDIDATES ||
        diagnostic.bytes + estimated > MAX_PENDING_CANDIDATE_BYTES
      ) {
        await store.fail({
          job: input.job,
          errorCode: "knowledge_candidate_capacity_exceeded",
          retry: "capacity",
          now: input.now,
        });
        return [];
      }
      const sourceByKey = new Map(
        input.sources.map((source) => [sourceRefKey(source.ref), source]),
      );
      const created: KnowledgeCandidate[] = [];
      database.exec("BEGIN IMMEDIATE;");
      try {
        for (const extracted of input.candidates) {
          const sourceRefs = uniqueSourceRefs(extracted.sourceRefs);
          if (sourceRefs.some((ref) => !sourceByKey.has(sourceRefKey(ref)))) {
            throw new Error("knowledge_source_ref_invalid");
          }
          const candidateId = stableId(
            "knowledge-candidate",
            refKey(input.job.rootRef),
            extracted.content.normalizedKey,
            input.job.sourceDigest,
          );
          const prior = readCurrentCandidate(database, candidateId);
          if (prior !== undefined) continue;
          const selected = sourceRefs.map((ref) => sourceByKey.get(sourceRefKey(ref))!);
          const candidate = KnowledgeCandidateSchema.parse({
            schemaVersion: "pragma.memory-knowledge-candidate/v1",
            id: candidateId,
            revision: 1,
            rootRef: input.job.rootRef,
            producerRefs: uniqueRefs(selected.flatMap((source) => source.producerRefs)),
            content: extracted.content,
            sourceRefs,
            sourceDigest: input.job.sourceDigest,
            state: "pending_review",
            proposedVisibility: strictestVisibility(selected),
            proposedSensitivity: strictestSensitivity(selected),
            extractor: input.provenance,
            createdAt: input.now.toISOString(),
            updatedAt: input.now.toISOString(),
          });
          writeCandidate(candidate);
          created.push(candidate);
        }
        writeJob(
          KnowledgeExtractionJobSchema.parse({
            ...input.job,
            revision: input.job.revision + 1,
            status: "completed",
            completion: created.length > 0 ? "retained" : "rejected",
            leaseUntil: undefined,
            updatedAt: input.now.toISOString(),
          }),
        );
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      return created;
    },
    async completeRejected(job, now) {
      assertCurrentJob(database, job);
      writeJob(
        KnowledgeExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status: "completed",
          completion: "rejected",
          leaseUntil: undefined,
          updatedAt: now.toISOString(),
        }),
      );
    },
    async fail(input) {
      const current = readJob(database, input.job.id);
      if (current?.revision !== input.job.revision || current.status !== "running") return;
      const needsAttention = input.retry !== "transient" || input.job.attempts >= 3;
      writeJob(
        KnowledgeExtractionJobSchema.parse({
          ...input.job,
          revision: input.job.revision + 1,
          status: needsAttention ? "needs_attention" : "pending",
          retryAt: needsAttention
            ? undefined
            : new Date(input.now.getTime() + 2 ** input.job.attempts * 1_000).toISOString(),
          leaseUntil: undefined,
          lastErrorCode: input.errorCode,
          failureClass: needsAttention
            ? input.retry === "capacity"
              ? "capacity"
              : input.retry === "configuration"
                ? "configuration"
                : "transient-exhausted"
            : undefined,
          updatedAt: input.now.toISOString(),
        }),
      );
    },
    async retryJob(input) {
      const job = readJob(database, input.id);
      if (job === undefined || job.revision !== input.expectedRevision) throw conflict();
      if (job.status !== "needs_attention") throw new Error("knowledge_job_not_retryable");
      writeJob(
        KnowledgeExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          status: "pending",
          attempts: 0,
          retryAt: undefined,
          lastErrorCode: undefined,
          failureClass: undefined,
          updatedAt: input.now.toISOString(),
        }),
      );
    },
    async expediteJob(input) {
      const job = readJob(database, input.id);
      assertManageableJob(job, input.expectedRevision, ["pending"]);
      writeJob(
        KnowledgeExtractionJobSchema.parse({
          ...job,
          revision: job.revision + 1,
          retryAt: input.now.toISOString(),
          leaseUntil: undefined,
          updatedAt: input.now.toISOString(),
        }),
      );
    },
    async interruptJob(input) {
      const job = readJob(database, input.id);
      assertManageableJob(job, input.expectedRevision, ["running"]);
      const interrupted = KnowledgeExtractionJobSchema.parse({
        ...job,
        revision: job.revision + 1,
        status: "pending",
        attempts: 0,
        retryAt: new Date(
          input.now.getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
        ).toISOString(),
        leaseUntil: undefined,
        lastErrorCode: undefined,
        failureClass: undefined,
        updatedAt: input.now.toISOString(),
      });
      writeJob(interrupted);
      return interrupted;
    },
    async deleteJob(input) {
      const job = readJob(database, input.id);
      assertManageableJob(job, input.expectedRevision, ["needs_attention"]);
      database.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
    },
    async wakeNeedsAttention(now, reason = "configuration") {
      const rows = database
        .prepare("SELECT job_json FROM jobs WHERE status='needs_attention'")
        .all() as { job_json: string }[];
      for (const row of rows) {
        const job = parseJob(row.job_json);
        if (reason === "configuration" && job.failureClass !== "configuration") continue;
        writeJob(
          KnowledgeExtractionJobSchema.parse({
            ...job,
            revision: job.revision + 1,
            status: "pending",
            attempts: 0,
            retryAt: undefined,
            lastErrorCode: undefined,
            failureClass: undefined,
            updatedAt: now.toISOString(),
          }),
        );
      }
    },
    async listJobs() {
      return (
        database.prepare("SELECT job_json FROM jobs ORDER BY rowid DESC").all() as {
          job_json: string;
        }[]
      ).map((row) => parseJob(row.job_json));
    },
    async listCandidates(state) {
      const rows = (
        state === undefined
          ? database
              .prepare(
                "SELECT candidate_json FROM candidates WHERE is_current=1 ORDER BY updated_at DESC",
              )
              .all()
          : database
              .prepare(
                "SELECT candidate_json FROM candidates WHERE is_current=1 AND state=? ORDER BY updated_at DESC",
              )
              .all(state)
      ) as { candidate_json: string }[];
      return rows.map((row) => KnowledgeCandidateSchema.parse(JSON.parse(row.candidate_json)));
    },
    async getCandidate(id) {
      return readCurrentCandidate(database, id);
    },
    async updateCandidate(input) {
      return withImmediateTransaction(database, () => {
        const current = requireCandidate(
          database,
          input.id,
          input.expectedRevision,
          "pending_review",
        );
        const next = KnowledgeCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          content: input.content,
          updatedAt: input.now.toISOString(),
        });
        writeCandidate(next);
        return next;
      });
    },
    async rejectCandidate(input) {
      return withImmediateTransaction(database, () => {
        const current = requireCandidate(
          database,
          input.id,
          input.expectedRevision,
          "pending_review",
        );
        const next = KnowledgeCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          state: "rejected",
          rejectionReason: input.reason,
          updatedAt: input.now.toISOString(),
        });
        writeCandidate(next);
        return next;
      });
    },
    async publishCandidate(input) {
      const candidate = requireCandidate(
        database,
        input.candidateId,
        input.expectedRevision,
        "pending_review",
      );
      if (
        input.bindings.length === 0 ||
        !input.bindings.some((binding) => binding.recall === "allow")
      ) {
        throw new Error("knowledge_recall_binding_required");
      }
      const existing = readByNormalizedKey(
        database,
        candidate.rootRef,
        candidate.content.normalizedKey,
      );
      if (candidate.successorOf === undefined && existing !== undefined) {
        throw new Error("knowledge_successor_required");
      }
      const predecessor =
        candidate.successorOf === undefined
          ? undefined
          : requireKnowledge(database, candidate.successorOf.id, candidate.successorOf.revision);
      if (
        predecessor !== undefined &&
        (predecessor.status !== "active" ||
          predecessor.content.normalizedKey !== candidate.content.normalizedKey ||
          existing?.id !== predecessor.id)
      ) {
        throw new Error("knowledge_successor_invalid");
      }
      const id =
        predecessor?.id ??
        stableId("knowledge", refKey(candidate.rootRef), candidate.content.normalizedKey);
      const timestamp = input.now.toISOString();
      const knowledge = KnowledgeSchema.parse({
        schemaVersion: "pragma.memory-knowledge/v1",
        id,
        revision: (predecessor?.revision ?? 0) + 1,
        rootRef: candidate.rootRef,
        producerRefs: candidate.producerRefs,
        content: candidate.content,
        sourceRefs: candidate.sourceRefs,
        sourceDigest: candidate.sourceDigest,
        status: "active",
        visibility: input.visibility,
        sensitivity: candidate.proposedSensitivity,
        bindings: input.bindings,
        origin: { kind: "local" },
        extractor: candidate.extractor,
        createdAt: predecessor?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      withImmediateTransaction(database, () => {
        writeKnowledge(knowledge);
        writeCandidate(
          KnowledgeCandidateSchema.parse({
            ...candidate,
            revision: candidate.revision + 1,
            state: "published",
            publishedRef: { id, revision: knowledge.revision },
            updatedAt: timestamp,
          }),
        );
        writeGovernance(
          database,
          knowledge,
          predecessor?.revision,
          predecessor === undefined ? "publish" : "successor",
          input.reason,
          input.actorRef,
          input.now,
        );
      });
      return knowledge;
    },
    async createSuccessor(input) {
      const current = requireKnowledge(database, input.knowledgeId, input.expectedRevision);
      if (current.status !== "active") throw new Error("knowledge_not_active");
      const timestamp = input.now.toISOString();
      const candidate = KnowledgeCandidateSchema.parse({
        schemaVersion: "pragma.memory-knowledge-candidate/v1",
        id: `${stableId("knowledge-successor", current.id, String(current.revision), timestamp)}`,
        revision: 1,
        rootRef: current.rootRef,
        producerRefs: current.producerRefs,
        content: input.content,
        sourceRefs: current.sourceRefs,
        sourceDigest: current.sourceDigest,
        state: "pending_review",
        proposedVisibility: current.visibility,
        proposedSensitivity: current.sensitivity,
        extractor: current.extractor ?? importedProvenance(timestamp),
        successorOf: { id: current.id, revision: current.revision },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      withImmediateTransaction(database, () => writeCandidate(candidate));
      return candidate;
    },
    async list() {
      return (
        database
          .prepare("SELECT knowledge_json FROM knowledge WHERE is_current=1 ORDER BY rowid DESC")
          .all() as { knowledge_json: string }[]
      ).map((row) => parseKnowledge(row.knowledge_json));
    },
    async get(id, revision) {
      return readKnowledge(database, id, revision);
    },
    async history(id) {
      return (
        database
          .prepare("SELECT knowledge_json FROM knowledge WHERE id=? ORDER BY revision DESC")
          .all(id) as { knowledge_json: string }[]
      ).map((row) => parseKnowledge(row.knowledge_json));
    },
    async listForRecall(scope) {
      return (await store.list()).filter((item) => canRecall(item, scope));
    },
    async searchForRecall(scope, query, limit) {
      const normalized = query.trim().toLocaleLowerCase();
      return (await store.listForRecall(scope))
        .filter((item) =>
          `${item.content.title}\n${item.content.summary}\n${item.content.guidance.join("\n")}`
            .toLocaleLowerCase()
            .includes(normalized),
        )
        .slice(0, limit);
    },
    async getForRecall(scope, id, revision) {
      const current = await store.get(id);
      if (current === undefined || !canRecall(current, scope)) return undefined;
      const item = revision === undefined ? current : await store.get(id, revision);
      return item !== undefined && canRecall(item, scope) ? item : undefined;
    },
    async tightenAccess(input) {
      const current = requireKnowledge(database, input.id, input.expectedRevision);
      const bindings = [...(input.bindings ?? current.bindings)];
      const visibility = input.visibility ?? current.visibility;
      assertMemoryBindingsTightened(current.bindings, bindings);
      assertMemoryVisibilityTightened(current.visibility, visibility);
      const next = KnowledgeSchema.parse({
        ...current,
        revision: current.revision + 1,
        bindings,
        visibility,
        updatedAt: input.now.toISOString(),
      });
      withImmediateTransaction(database, () => {
        writeKnowledge(next);
        writeGovernance(
          database,
          next,
          current.revision,
          "tighten-access",
          input.reason,
          input.actorRef,
          input.now,
        );
      });
      return next;
    },
    async withdraw(input) {
      const current = requireKnowledge(database, input.id, input.expectedRevision);
      if (current.status !== "active") throw new Error("knowledge_not_active");
      const next = KnowledgeSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "withdrawn",
        withdrawnAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      });
      withImmediateTransaction(database, () => {
        writeKnowledge(next);
        writeGovernance(
          database,
          next,
          current.revision,
          "withdraw",
          input.reason,
          input.actorRef,
          input.now,
        );
      });
      return next;
    },
    async listExportable(input) {
      const requested = new Set(input.refs.map((ref) => `${ref.id}\0${ref.revision}`));
      if (requested.size !== input.refs.length)
        throw new Error("knowledge_export_duplicate_revision");
      const result: Knowledge[] = [];
      for (const ref of input.refs) {
        const item = await store.get(ref.id, ref.revision);
        if (item === undefined) throw new Error("knowledge_export_revision_missing");
        if (item.status !== "active") throw new Error("knowledge_export_inactive");
        const current = await store.get(ref.id);
        if (current === undefined || current.status !== "active") {
          throw new Error("knowledge_export_inactive");
        }
        if (current.visibility.mode === "host-private" || current.sensitivity === "restricted") {
          throw new Error("knowledge_export_prohibited");
        }
        if (item.visibility.mode === "host-private" || item.sensitivity === "restricted") {
          throw new Error("knowledge_export_prohibited");
        }
        const binding = item.bindings.find(
          (candidate) =>
            sameRef(candidate.consumerRef, input.projectRef) && candidate.export === "allow",
        );
        const currentBinding = current.bindings.find(
          (candidate) =>
            sameRef(candidate.consumerRef, input.projectRef) && candidate.export === "allow",
        );
        if (binding === undefined || currentBinding === undefined) {
          throw new Error("knowledge_export_not_allowed");
        }
        result.push(item);
      }
      return result;
    },
    async importShares(input) {
      return withImmediateTransaction(database, () => {
        const imported: Knowledge[] = [];
        for (const raw of input.shares) {
          const share = KnowledgeShareSchema.parse(raw);
          assertKnowledgeShareDigest(share);
          if (share.visibility.mode === "host-private" || share.sensitivity === "restricted") {
            throw new Error("knowledge_import_prohibited");
          }
          const mappedRoot = input.mapRef(share.rootRef);
          if (mappedRoot === undefined) throw new Error("knowledge_import_root_unmapped");
          const mappedProducers = share.producerRefs.map(input.mapRef).filter(isDefined);
          const mappedBindings = share.bindings.map((binding) => {
            const consumerRef = input.mapRef(binding.consumerRef);
            if (consumerRef === undefined) throw new Error("knowledge_import_binding_unmapped");
            return { ...binding, consumerRef };
          });
          const mappedVisibility = mapVisibility(share.visibility, input.mapRef);
          const id = stableId(
            "imported-knowledge",
            share.sourceProjectFingerprint,
            share.sourceRef.id,
          );
          const current = readKnowledge(database, id);
          if (current?.origin.kind === "bundle-import") {
            if (current.origin.sourceRevision === share.sourceRef.revision) {
              if (current.origin.sourceDigest !== share.digest)
                throw new Error("knowledge_import_digest_mismatch");
              continue;
            }
            if (current.origin.sourceRevision > share.sourceRef.revision) continue;
          }
          const revision = (current?.revision ?? 0) + 1;
          const timestamp = input.now.toISOString();
          const knowledge = KnowledgeSchema.parse({
            schemaVersion: "pragma.memory-knowledge/v1",
            id,
            revision,
            rootRef: mappedRoot,
            producerRefs: mappedProducers,
            content: share.content,
            sourceRefs: [],
            sourceDigest: share.sourceDigest,
            status: "active",
            visibility: mappedVisibility,
            sensitivity: share.sensitivity,
            bindings: mappedBindings,
            origin: {
              kind: "bundle-import",
              sourceProjectFingerprint: share.sourceProjectFingerprint,
              sourceKnowledgeId: share.sourceRef.id,
              sourceRevision: share.sourceRef.revision,
              sourceDigest: share.digest,
              importedAt: timestamp,
            },
            createdAt: current?.createdAt ?? timestamp,
            updatedAt: timestamp,
          });
          writeKnowledge(knowledge);
          writeGovernance(
            database,
            knowledge,
            current?.revision,
            "bundle-import",
            "Imported from a Pragma Bundle.",
            input.actorRef,
            input.now,
          );
          imported.push(knowledge);
        }
        return imported;
      });
    },
    async maintain(now) {
      const cutoff = new Date(now.getTime() - CANDIDATE_BODY_RETENTION_MS).toISOString();
      const result = database
        .prepare(`DELETE FROM candidates WHERE state IN ('rejected','superseded') AND updated_at<?`)
        .run(cutoff);
      return { purgedCandidateBodies: Number(result.changes) };
    },
    async inspect() {
      const capacity = readCandidateCapacity(database);
      const statuses = database
        .prepare(
          `SELECT status, COUNT(*) AS count FROM jobs WHERE status IN ('pending','running','needs_attention') GROUP BY status`,
        )
        .all() as { status: string; count: number }[];
      const counts = new Map(statuses.map((row) => [row.status, Number(row.count)]));
      const last = database
        .prepare(
          "SELECT job_json FROM jobs WHERE status='needs_attention' ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { job_json: string } | undefined;
      return {
        knowledge: count(database, "knowledge", "is_current=1"),
        pending: counts.get("pending") ?? 0,
        running: counts.get("running") ?? 0,
        needsAttention: counts.get("needs_attention") ?? 0,
        rejected: count(database, "candidates", "is_current=1 AND state='rejected'"),
        candidateBytes: capacity.bytes,
        lastErrorCode: last === undefined ? undefined : parseJob(last.job_json).lastErrorCode,
      };
    },
    close() {
      database.close();
    },
  };
  return store;
}

function initialize(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
    CREATE TABLE IF NOT EXISTS knowledge(
      id TEXT NOT NULL, revision INTEGER NOT NULL, root_key TEXT NOT NULL,
      normalized_key TEXT NOT NULL, status TEXT NOT NULL, is_current INTEGER NOT NULL,
      source_origin_key TEXT, knowledge_json TEXT NOT NULL,
      PRIMARY KEY(id, revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_current_id ON knowledge(id) WHERE is_current=1;
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_current_key ON knowledge(root_key, normalized_key) WHERE is_current=1;
    CREATE INDEX IF NOT EXISTS knowledge_origin ON knowledge(source_origin_key);
    CREATE TABLE IF NOT EXISTS candidates(
      id TEXT NOT NULL, revision INTEGER NOT NULL, root_key TEXT NOT NULL,
      normalized_key TEXT NOT NULL, source_digest TEXT NOT NULL, state TEXT NOT NULL,
      body_bytes INTEGER NOT NULL, is_current INTEGER NOT NULL, updated_at TEXT NOT NULL,
      candidate_json TEXT NOT NULL, PRIMARY KEY(id, revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS candidates_current_id ON candidates(id) WHERE is_current=1;
    CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, root_key TEXT NOT NULL, source_digest TEXT NOT NULL,
      status TEXT NOT NULL, retry_at TEXT, lease_until TEXT, job_json TEXT NOT NULL,
      UNIQUE(root_key, source_digest)
    );
    CREATE TABLE IF NOT EXISTS governance(
      id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, revision INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
  `);
}

function assertFreshOrCurrent(database: DatabaseSync): void {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get();
  if (row === undefined) {
    assertFreshSqliteDatabase(database, "pragma.memory-knowledge-store");
    return;
  }
  const version = database.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    { version: number } | undefined;
  if (version?.version !== 1) throw new Error("Unsupported pragma.memory-knowledge-store version.");
}

function parseJob(json: string): KnowledgeExtractionJob {
  return KnowledgeExtractionJobSchema.parse(JSON.parse(json));
}

function parseKnowledge(json: string): Knowledge {
  return KnowledgeSchema.parse(JSON.parse(json));
}

function readJob(database: DatabaseSync, id: string): KnowledgeExtractionJob | undefined {
  const row = database.prepare("SELECT job_json FROM jobs WHERE id=?").get(id) as
    { job_json: string } | undefined;
  return row === undefined ? undefined : parseJob(row.job_json);
}

function readCurrentCandidate(database: DatabaseSync, id: string): KnowledgeCandidate | undefined {
  const row = database
    .prepare("SELECT candidate_json FROM candidates WHERE id=? AND is_current=1")
    .get(id) as { candidate_json: string } | undefined;
  return row === undefined
    ? undefined
    : KnowledgeCandidateSchema.parse(JSON.parse(row.candidate_json));
}

function requireCandidate(
  database: DatabaseSync,
  id: string,
  revision: number,
  state: KnowledgeCandidate["state"],
): KnowledgeCandidate {
  const candidate = readCurrentCandidate(database, id);
  if (candidate === undefined || candidate.revision !== revision) throw conflict();
  if (candidate.state !== state) throw new Error(`knowledge_candidate_not_${state}`);
  return candidate;
}

function readKnowledge(
  database: DatabaseSync,
  id: string,
  revision?: number,
): Knowledge | undefined {
  const row = (
    revision === undefined
      ? database.prepare("SELECT knowledge_json FROM knowledge WHERE id=? AND is_current=1").get(id)
      : database
          .prepare("SELECT knowledge_json FROM knowledge WHERE id=? AND revision=?")
          .get(id, revision)
  ) as { knowledge_json: string } | undefined;
  return row === undefined ? undefined : parseKnowledge(row.knowledge_json);
}

function requireKnowledge(database: DatabaseSync, id: string, revision: number): Knowledge {
  const item = readKnowledge(database, id);
  if (item === undefined || item.revision !== revision) throw conflict();
  return item;
}

function readByNormalizedKey(
  database: DatabaseSync,
  rootRef: MemorySubjectRef,
  normalizedKey: string,
): Knowledge | undefined {
  const row = database
    .prepare(
      "SELECT knowledge_json FROM knowledge WHERE root_key=? AND normalized_key=? AND is_current=1",
    )
    .get(refKey(rootRef), normalizedKey) as { knowledge_json: string } | undefined;
  return row === undefined ? undefined : parseKnowledge(row.knowledge_json);
}

function assertCurrentJob(database: DatabaseSync, job: KnowledgeExtractionJob): void {
  const current = readJob(database, job.id);
  if (current?.revision !== job.revision || current.status !== "running") throw conflict();
}

function readCandidateCapacity(database: DatabaseSync): { pending: number; bytes: number } {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS pending, COALESCE(SUM(body_bytes),0) AS bytes FROM candidates WHERE is_current=1 AND state='pending_review'",
    )
    .get() as { pending: number; bytes: number };
  return { pending: Number(row.pending), bytes: Number(row.bytes) };
}

function canRecall(item: Knowledge, scope: MemoryRecallScope): boolean {
  if (item.status !== "active" || !sameRef(item.rootRef, scope.rootRef)) return false;
  if (item.visibility.mode === "restricted") {
    const principals = [scope.expertRef, ...(scope.principalRefs ?? [])];
    if (
      !item.visibility.principals.some((allowed) => principals.some((ref) => sameRef(ref, allowed)))
    ) {
      return false;
    }
  }
  const consumers = [scope.expertRef, ...(scope.principalRefs ?? [])];
  return item.bindings.some(
    (binding) =>
      binding.recall === "allow" && consumers.some((ref) => sameRef(ref, binding.consumerRef)),
  );
}

function writeGovernance(
  database: DatabaseSync,
  knowledge: Knowledge,
  previousRevision: number | undefined,
  action: "publish" | "successor" | "tighten-access" | "withdraw" | "bundle-import",
  reason: string,
  actorRef: MemorySubjectRef,
  now: Date,
): void {
  const event = KnowledgeGovernanceEventSchema.parse({
    schemaVersion: "pragma.memory-knowledge-governance-event/v1",
    id: randomUUID(),
    knowledgeId: knowledge.id,
    previousRevision,
    revision: knowledge.revision,
    action,
    reason,
    actorRef,
    occurredAt: now.toISOString(),
  });
  database
    .prepare("INSERT INTO governance(id, knowledge_id, revision, event_json) VALUES (?, ?, ?, ?)")
    .run(event.id, event.knowledgeId, event.revision, JSON.stringify(event));
}

function withImmediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE;");
  try {
    const result = operation();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // The failed statement may already have ended the transaction.
    }
    throw error;
  }
}

function strictestSensitivity(
  sources: readonly KnowledgeSourceSnapshot[],
): Knowledge["sensitivity"] {
  const order = ["public", "internal", "confidential", "restricted"] as const;
  return order[Math.max(0, ...sources.map((source) => order.indexOf(source.sensitivity)))]!;
}

function strictestVisibility(sources: readonly KnowledgeSourceSnapshot[]): Knowledge["visibility"] {
  if (sources.some((source) => source.visibility.mode === "host-private"))
    return { mode: "host-private" };
  const restricted = sources.filter((source) => source.visibility.mode === "restricted");
  if (restricted.length === 0) return { mode: "public" };
  const principals = restricted
    .map(
      (source) =>
        new Map(
          source.visibility.mode === "restricted"
            ? source.visibility.principals.map((ref) => [refKey(ref), ref])
            : [],
        ),
    )
    .reduce((left, right) => new Map([...left].filter(([key]) => right.has(key))));
  return principals.size === 0
    ? { mode: "host-private" }
    : { mode: "restricted", principals: [...principals.values()] };
}

function mapVisibility(
  visibility: Knowledge["visibility"],
  mapRef: (ref: MemorySubjectRef) => MemorySubjectRef | undefined,
): Knowledge["visibility"] {
  if (visibility.mode !== "restricted") return visibility;
  const principals = visibility.principals.map(mapRef);
  if (principals.some((ref) => ref === undefined))
    throw new Error("knowledge_import_principal_unmapped");
  return { mode: "restricted", principals: principals.filter(isDefined) };
}

function importedProvenance(now: string): KnowledgeExtractorProvenance {
  return {
    curatorRef: "pragma.memory.knowledge.imported",
    promptVersion: "imported/v1",
    profileRevision: 0,
    runtimeId: "pragma.runtime.import",
    providerId: "pragma.bundle",
    modelId: "none",
    extractedAt: now,
  };
}

function stableId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function assertDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Invalid Knowledge source digest.");
  return value;
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function sourceRefKey(ref: {
  readonly kind: string;
  readonly id: string;
  readonly revision: number;
}): string {
  return `${ref.kind}\0${ref.id}\0${ref.revision}`;
}

function sameRef(left: MemorySubjectRef, right: MemorySubjectRef): boolean {
  return left.type === right.type && left.id === right.id;
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): readonly MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

function uniqueSourceRefs<
  T extends { readonly kind: string; readonly id: string; readonly revision: number },
>(refs: readonly T[]): readonly T[] {
  return [...new Map(refs.map((ref) => [sourceRefKey(ref), ref])).values()];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function conflict(): Error {
  return new Error("knowledge_revision_conflict");
}

function assertManageableJob(
  job: KnowledgeExtractionJob | undefined,
  expectedRevision: number,
  statuses: readonly KnowledgeExtractionJob["status"][],
): asserts job is KnowledgeExtractionJob {
  if (job === undefined) throw new Error("knowledge_job_not_found");
  if (job.revision !== expectedRevision) throw conflict();
  if (!statuses.includes(job.status)) throw new Error("knowledge_job_action_invalid");
}

function count(database: DatabaseSync, table: "knowledge" | "candidates", where: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as {
    count: number;
  };
  return Number(row.count);
}
