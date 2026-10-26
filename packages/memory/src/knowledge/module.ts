import type { MemoryRevisionExecutor } from "../learning/revision-execution.ts";
import {
  KnowledgeLearningPlanSchema,
  MEMORY_LEARNING_POLICY_VERSION,
} from "../learning/revision-plan.ts";
import { createLearningDecisionStore, learningFingerprint } from "../learning/decision-store.ts";
import { createHash } from "node:crypto";
import { StaticContextStore } from "@pragma/core";

import {
  KnowledgeSourceSnapshotSchema,
  type KnowledgeSourceSnapshot,
  type MemoryExtractionFailurePhase,
  type MemorySubjectRef,
} from "@pragma/shared";

import type { KnowledgeSourceReader } from "./schema.ts";
import { createKnowledgeLearningStore, type KnowledgeLearningStore } from "./store.ts";
import { extractionFailureDiagnostic } from "../pipeline/extraction-error-code.ts";
import type { MemoryModule } from "../pipeline/memory-module.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import type {
  ExistingKnowledgeLearningTarget,
  KnowledgeLearningPlan,
} from "../learning/revision-plan.ts";
import { createMemoryLearningPolicyGuard } from "../learning/learning-policy.ts";
import { writeMemoryLearningTaskPresentation } from "../learning/task-presentation.ts";

const MAX_SOURCE_REVISIONS =
  DEFAULT_MEMORY_STORAGE_POLICY.episodicMaxRecords +
  DEFAULT_MEMORY_STORAGE_POLICY.semanticMaxRecords;

export type { KnowledgeSourceReader } from "./schema.ts";

export interface KnowledgeMemoryModule extends MemoryModule {
  readonly store: KnowledgeLearningStore;
  setExecutor(executor: MemoryRevisionExecutor | undefined): Promise<void>;
  /** Historical plan handoff only; Desktop never installs a planner for new work. */
  setPlanner(planner: KnowledgeLearningPlanner | undefined): Promise<void>;
  scheduleRoot(rootRef: MemorySubjectRef): Promise<void>;
  interruptExtractionJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  close(): void;
}

export interface KnowledgeLearningSink {
  readTarget?(target: ExistingKnowledgeLearningTarget): Promise<string>;
  listTargets?(input: {
    readonly expertRef: string;
  }): Promise<readonly ExistingKnowledgeLearningTarget[]>;
  assertAvailable?(input: {
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly plan?: Extract<KnowledgeLearningPlan, { action: "apply" }>;
  }): Promise<void>;
  submit(input: {
    readonly rootRef: MemorySubjectRef;
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly plan: Extract<KnowledgeLearningPlan, { action: "apply" }>;
    readonly sources: readonly KnowledgeSourceSnapshot[];
  }): Promise<void>;
}

export interface KnowledgeLearningPlanner {
  hasPending?(sourceDigest: string): Promise<boolean>;
  prepareDirectRetry?(sourceDigest: string): Promise<boolean>;
  settle?(sourceDigest: string): Promise<void>;
  plan(input: {
    readonly rootRef: MemorySubjectRef;
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly sources: readonly KnowledgeSourceSnapshot[];
    readonly existingTargets: readonly ExistingKnowledgeLearningTarget[];
    readonly readTarget?:
      ((target: ExistingKnowledgeLearningTarget) => Promise<string>) | undefined;
    readonly signal: AbortSignal;
  }): Promise<KnowledgeLearningPlan>;
}

export async function createKnowledgeMemoryModule(options: {
  readonly sourceReader: KnowledgeSourceReader;
  readonly pragmaHome?: string | undefined;
  readonly executor?: MemoryRevisionExecutor | undefined;
  readonly planner?: KnowledgeLearningPlanner | undefined;
  readonly learningSink: KnowledgeLearningSink;
  readonly now?: (() => Date) | undefined;
}): Promise<KnowledgeMemoryModule> {
  const store = await createKnowledgeLearningStore(options);
  const now = options.now ?? (() => new Date());
  let decisions: ReturnType<typeof createLearningDecisionStore>;
  try {
    decisions = createLearningDecisionStore(options, "knowledge");
  } catch (error) {
    store.close();
    throw error;
  }
  const canLearn = createMemoryLearningPolicyGuard({ ...options, now });
  let planner = options.planner;
  let executor = options.executor;
  const running = new Map<string, AbortController>();

  // Recheck persisted work on access as well as in the background, including
  // jobs left behind by an earlier process before the source was invalidated.
  const reconcileJobs = async (rootRef?: MemorySubjectRef): Promise<void> => {
    const jobs = (await store.listJobs()).filter(
      (job) =>
        job.status !== "completed" &&
        (rootRef === undefined ||
          (job.rootRef.type === rootRef.type && job.rootRef.id === rootRef.id)),
    );
    const roots = new Map(jobs.map((job) => [JSON.stringify(job.rootRef), job.rootRef]));
    for (const root of roots.values()) {
      const sources = boundSources(
        await options.sourceReader.listEligibleSources({
          rootRef: root,
          limit: MAX_SOURCE_REVISIONS,
          now: now(),
        }),
      );
      const currentDigest = digest(
        "knowledge-sources",
        MEMORY_LEARNING_POLICY_VERSION,
        ...sources.map(sourceDigestKey).toSorted(),
      );
      let discarded = false;
      for (const job of jobs.filter(
        (candidate) =>
          candidate.rootRef.type === root.type &&
          candidate.rootRef.id === root.id &&
          (sources.length === 0 || candidate.sourceDigest !== currentDigest),
      )) {
        if (await store.discardJob({ id: job.id, expectedRevision: job.revision })) {
          discarded = true;
          running.get(job.id)?.abort();
        }
      }
      if (discarded && sources.length > 0 && (await canLearn(root))) {
        const next = await store.schedule({
          rootRef: root,
          sourceDigest: currentDigest,
          now: now(),
        });
        if (next !== undefined)
          writeMemoryLearningTaskPresentation(
            options,
            { module: "knowledge", ...next },
            { sources },
          );
      }
    }
  };

  const scheduleRoot = async (rootRef: MemorySubjectRef): Promise<void> => {
    if (!(await canLearn(rootRef))) return;
    const sources = boundSources(
      await options.sourceReader.listEligibleSources({
        rootRef,
        limit: MAX_SOURCE_REVISIONS,
        now: now(),
      }),
    );
    if (sources.length === 0) {
      await reconcileJobs(rootRef);
      return;
    }
    const job = await store.schedule({
      rootRef,
      sourceDigest: digest(
        "knowledge-sources",
        MEMORY_LEARNING_POLICY_VERSION,
        ...sources.map(sourceDigestKey).toSorted(),
      ),
      now: now(),
    });
    if (job !== undefined)
      writeMemoryLearningTaskPresentation(options, { module: "knowledge", ...job }, { sources });
  };

  const managedStore: KnowledgeLearningStore = {
    ...store,
    async listJobs() {
      await reconcileJobs();
      return store.listJobs();
    },
    async listJobsPage(input) {
      await reconcileJobs();
      return store.listJobsPage(input);
    },
    async inspect() {
      await reconcileJobs();
      return store.inspect();
    },
  };

  return {
    descriptor: {
      id: "pragma.memory.knowledge-learning",
      version: "2.0.0",
      pathPrefix: "knowledge-learning",
      storageModel: "immutable-revision",
      purpose: "learning",
      contextLayers: {
        usagePrompt:
          "Knowledge learning creates managed Studio Context Store revision drafts. It has no recallable published projection.",
        summaryPath: "summary.md",
        indexPath: "index.md",
        itemsPrefix: "items/",
        evidencePrefix: "evidence/",
        summaryMaxBytes: 2_048,
        indexMaxBytes: 4_096,
      },
    },
    subscriptions: [],
    createContextProvider() {
      return new StaticContextStore();
    },
    async consume() {
      return {};
    },
    async runBackgroundOnce() {
      if (!(await canLearn())) return;
      await reconcileJobs();
      if (planner === undefined && executor === undefined) return;
      const ownedObservations = new Set<string>();
      if (executor?.canObserveJob !== undefined) {
        for (const candidate of await store.listJobs()) {
          const mayObserve =
            candidate.lastErrorCode === "memory_revision_observation_pending" ||
            (candidate.status === "needs_attention" &&
              candidate.lastErrorCode === "memory_extraction_execution_unconfirmed") ||
            (candidate.status === "running" &&
              candidate.leaseUntil !== undefined &&
              Date.parse(candidate.leaseUntil) <= now().getTime());
          if (mayObserve && (await executor.canObserveJob(candidate.id))) {
            ownedObservations.add(candidate.id);
            if (candidate.status === "needs_attention")
              await store.resumeObservation(candidate.id, now());
          }
        }
      }
      const job = await store.claimDueJob(now(), ownedObservations);
      if (job === undefined) return;
      const controller = new AbortController();
      running.set(job.id, controller);
      const startedAt = now();
      let phase: MemoryExtractionFailurePhase = "source_read";
      let modelRequested = false;
      try {
        const available = await options.sourceReader.listEligibleSources({
          rootRef: job.rootRef,
          limit: MAX_SOURCE_REVISIONS,
          now: now(),
        });
        const sources = boundSources(available);
        if (sources.length === 0) {
          await store.discardJob({ id: job.id, expectedRevision: job.revision });
          return;
        }
        const sourceDigest = digest(
          "knowledge-sources",
          MEMORY_LEARNING_POLICY_VERSION,
          ...sources.map(sourceDigestKey).toSorted(),
        );
        if (job.sourceDigest !== sourceDigest) {
          await store.discardJob({ id: job.id, expectedRevision: job.revision });
          return;
        }
        writeMemoryLearningTaskPresentation(options, { module: "knowledge", ...job }, { sources });
        const expertRefs = new Set(
          sources
            .flatMap((source) => source.producerRefs)
            .filter((ref) => ref.type === "pragma.expert")
            .map((ref) => `expert:${ref.id}`),
        );
        if (expertRefs.size === 0 && job.rootRef.type === "pragma.expert") {
          expertRefs.add(`expert:${job.rootRef.id}`);
        }
        let submitted = false;
        for (const expertRef of expertRefs) {
          const producerSources = sources.filter((source) =>
            source.producerRefs.some(
              (ref) => ref.type === "pragma.expert" && `expert:${ref.id}` === expertRef,
            ),
          );
          const expertSources = producerSources.length > 0 ? producerSources : sources;
          if (!knowledgeSourceSelectionEligible(expertSources)) continue;
          const producers = expertSources.flatMap((source) => source.producerRefs);
          if (!(await canLearn(job.rootRef, producers))) {
            // A policy pause must yield even after the original debounce deadline.
            const pausedAt = now();
            await store.interruptJob({
              id: job.id,
              expectedRevision: job.revision,
              now: pausedAt,
              retryAt: new Date(
                pausedAt.getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
              ),
            });
            return;
          }
          if (!(await store.isClaimCurrent(job))) return;
          controller.signal.throwIfAborted();
          const expertDigest = digest(
            "knowledge-expert-sources",
            expertRef,
            ...expertSources.map(sourceDigestKey).toSorted(),
          );
          phase = "revision_submit";
          const existingTargets = (await options.learningSink.listTargets?.({ expertRef })) ?? [];
          if (!(await store.isClaimCurrent(job))) return;
          controller.signal.throwIfAborted();
          const evaluationKey = learningFingerprint({
            policy: MEMORY_LEARNING_POLICY_VERSION,
            expertRef,
            rootRef: job.rootRef,
            sources: expertSources,
            existingTargets,
          });
          if (decisions.has(evaluationKey)) {
            decisions.write(learningFingerprint({ evaluationKey, jobId: job.id }), job.id, {
              outcome: "duplicate",
              reason:
                "The effective Memory sources and editable target versions have not changed since the previous assessment.",
              targets: [],
            });
            continue;
          }
          const explicitLegacyRetry =
            executor !== undefined &&
            job.attempts === 1 &&
            job.lastFailure === undefined &&
            (await store.listFailureAttempts(job.id)).length > 0;
          const directRetry =
            explicitLegacyRetry && (await planner?.prepareDirectRetry?.(expertDigest)) === true;
          if (directRetry) decisions.discardPlan(evaluationKey);
          if (
            executor !== undefined &&
            (directRetry ||
              (decisions.readPlan(evaluationKey) === undefined &&
                !((await planner?.hasPending?.(expertDigest)) ?? false)))
          ) {
            phase = "revision_submit";
            modelRequested = !(
              (await executor.hasExecution?.({
                kind: "knowledge",
                jobId: job.id,
                expertRef,
                sourceDigest: expertDigest,
              })) ?? false
            );
            if (
              !modelRequested &&
              job.lastErrorCode === "memory_revision_observation_pending" &&
              executor.hasExecution === undefined
            )
              throw Object.assign(new Error("memory_revision_owner_unconfirmed"), {
                retryable: false,
              });
            if (modelRequested && job.lastErrorCode === "memory_revision_observation_pending")
              throw Object.assign(new Error("memory_revision_owner_unconfirmed"), {
                retryable: false,
              });
            const result = await executor.execute({
              kind: "knowledge",
              jobId: job.id,
              claimRevision: job.revision,
              manualRetry: job.attempts === 1 && job.lastFailure === undefined,
              retryFailedExecution: job.lastFailure?.retryable === true,
              onAdmission: (admitted) => {
                modelRequested = admitted;
              },
              rootRef: job.rootRef,
              expertRef,
              sourceDigest: expertDigest,
              sources: expertSources,
              signal: controller.signal,
              assertCurrent: async () => {
                controller.signal.throwIfAborted();
                await reconcileJobs(job.rootRef);
                if (
                  !(await store.listJobs()).some(
                    (current) =>
                      current.id === job.id &&
                      current.sourceDigest === job.sourceDigest &&
                      current.status !== "completed",
                  ) ||
                  !(await canLearn(job.rootRef, producers))
                )
                  throw Object.assign(new Error("memory_revision_source_changed"), {
                    retryable: false,
                  });
              },
            });
            decisions.write(evaluationKey, job.id, result.decision);
            submitted ||= result.submitted;
            continue;
          }
          phase = "revision_plan";
          const cachedPlan = decisions.readPlan(evaluationKey);
          modelRequested ||= cachedPlan === undefined;
          const plan =
            cachedPlan === undefined
              ? await planner!.plan({
                  rootRef: job.rootRef,
                  expertRef,
                  sourceDigest: expertDigest,
                  sources: expertSources,
                  existingTargets,
                  readTarget: options.learningSink.readTarget,
                  signal: controller.signal,
                })
              : KnowledgeLearningPlanSchema.parse(cachedPlan);
          if (cachedPlan !== undefined && plan.action === "apply")
            plan.sourceRefs = plan.sourceRefs.map(
              (ref) =>
                expertSources.find(
                  (source) => source.ref.kind === ref.kind && source.ref.id === ref.id,
                )?.ref ?? ref,
            );
          if (!(await canLearn(job.rootRef, producers))) {
            // A policy pause must yield even after the original debounce deadline.
            const pausedAt = now();
            await store.interruptJob({
              id: job.id,
              expectedRevision: job.revision,
              now: pausedAt,
              retryAt: new Date(
                pausedAt.getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
              ),
            });
            return;
          }
          await reconcileJobs(job.rootRef);
          controller.signal.throwIfAborted();
          if (!(await store.isClaimCurrent(job))) return;
          if (plan.action === "skip") {
            if (plan.waitForTarget !== undefined) {
              if (
                !existingTargets.some(
                  (target) => target.storeId === plan.waitForTarget && target.pending,
                )
              )
                throw Object.assign(new Error("memory_learning_invalid_wait_target"), {
                  retryable: false,
                });
              decisions.writePlan(evaluationKey, plan);
              throw new Error("memory_revision_pending");
            }
            decisions.write(evaluationKey, job.id, {
              outcome: plan.disposition ?? "accumulate",
              reason: plan.reason ?? "No supported incremental change.",
              targets: [],
            });
            await planner?.settle?.(expertDigest);
            continue;
          }
          const selected = plan.sourceRefs.map((ref) =>
            expertSources.find(
              (source) =>
                source.ref.kind === ref.kind &&
                source.ref.id === ref.id &&
                source.ref.revision === ref.revision,
            ),
          );
          if (
            selected.some((source) => source === undefined) ||
            new Set(plan.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`)).size !==
              plan.sourceRefs.length
          )
            throw Object.assign(new Error("knowledge_learning_plan_invalid_sources"), {
              retryable: false,
            });
          const selectedSources = selected as KnowledgeSourceSnapshot[];
          if (plan.target.type === "revise") {
            const target = plan.target;
            if (
              !existingTargets.some(
                (item) =>
                  item.storeId === target.storeId &&
                  item.baseRevision === target.baseRevision &&
                  item.snapshotHash === target.snapshotHash,
              )
            )
              throw Object.assign(new Error("knowledge_learning_plan_invalid_target"), {
                retryable: false,
              });
          } else {
            const conversations = new Set(
              selectedSources
                .flatMap((source) => source.conversationRefs ?? [])
                .map((ref) => `${ref.type}:${ref.id}`),
            );
            const mature =
              plan.maturity === "cross-conversation"
                ? conversations.size >= 2
                : plan.maturity === "validated-artifact" &&
                  selectedSources.some(
                    (source) => source.ref.kind === "episodic" && source.outcome === "succeeded",
                  );
            if (!mature)
              throw Object.assign(new Error("knowledge_learning_topic_immature"), {
                retryable: false,
              });
          }
          if (cachedPlan === undefined) decisions.writePlan(evaluationKey, plan);
          const proposalKey = learningFingerprint({
            expertRef,
            target: plan.target.type === "create" ? { type: "create" } : plan.target,
            sources: selectedSources.map(({ ref, ...source }) => ({
              ...source,
              ref: { kind: ref.kind, id: ref.id },
            })),
          });
          if (decisions.has(proposalKey)) {
            decisions.write(evaluationKey, job.id, {
              outcome: "duplicate",
              reason: "The same supported proposal was already submitted for review.",
              targets: [plan.name],
            });
            continue;
          }
          await options.learningSink.assertAvailable?.({
            expertRef,
            sourceDigest: proposalKey,
            plan,
          });
          controller.signal.throwIfAborted();
          if (!(await store.isClaimCurrent(job))) return;
          writeMemoryLearningTaskPresentation(
            options,
            { module: "knowledge", ...job },
            { sources, plannedTitles: [plan.name] },
          );
          phase = "revision_submit";
          await options.learningSink.submit({
            rootRef: job.rootRef,
            expertRef,
            sourceDigest: proposalKey,
            plan,
            sources: selectedSources,
          });
          const decision = {
            outcome: plan.target.type,
            reason: plan.rationale,
            targets: [plan.name],
          };
          decisions.write(proposalKey, job.id, decision);
          decisions.write(evaluationKey, job.id, decision);
          await planner?.settle?.(expertDigest);
          submitted = true;
        }
        if (submitted) await store.completeLearned(job, now());
        else await store.completeRejected(job, now());
      } catch (error) {
        if (error instanceof Error && error.message === "memory_revision_observation_pending") {
          await store.deferObservation(job, now());
          return;
        }
        const failure = extractionFailureDiagnostic(error, "knowledge_extraction", {
          phase,
          startedAt,
          now: now(),
        });
        await store.fail({
          job,
          modelRequested,
          ...failure,
          diagnostic:
            modelRequested && isConfigurationError(error)
              ? { ...failure.diagnostic, retryable: false }
              : failure.diagnostic,
          retry: isConfigurationError(error) ? "configuration" : "transient",
          now: new Date(failure.diagnostic.failedAt),
        });
      } finally {
        if (running.get(job.id) === controller) running.delete(job.id);
      }
    },
    async setExecutor(next) {
      executor = next;
    },
    async setPlanner(next) {
      planner = next;
    },
    scheduleRoot,
    async interruptExtractionJob(input) {
      const interrupted = await store.interruptJob(input);
      running.get(interrupted.id)?.abort();
    },
    store: managedStore,
    close() {
      decisions.close();
      managedStore.close();
    },
  };
}

function boundSources(
  sources: readonly KnowledgeSourceSnapshot[],
): readonly KnowledgeSourceSnapshot[] {
  return sources
    .filter((source) => KnowledgeSourceSnapshotSchema.safeParse(source).success)
    .slice(0, MAX_SOURCE_REVISIONS);
}

export function knowledgeSourceSelectionEligible(
  sources: readonly KnowledgeSourceSnapshot[],
): boolean {
  return sources.length > 0;
}

/** Detects effective source-content changes while ignoring revision-only churn. */
function sourceDigestKey(source: KnowledgeSourceSnapshot): string {
  return JSON.stringify({
    kind: source.ref.kind,
    id: source.ref.id,
    producerRefs: source.producerRefs,
    sourceExecutionIds: source.sourceExecutionIds,
    conversationRefs: source.conversationRefs,
    outcome: source.outcome,
    title: source.title,
    body: source.body,
    observedAt: source.observedAt,
    verified: source.verified,
    valueScore: source.valueScore,
    visibility: source.visibility,
    sensitivity: source.sensitivity,
  });
}

function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function isConfigurationError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "memoryRevisionTransient" in error &&
    error.memoryRevisionTransient === true
  )
    return false;
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unavailable|not configured|profile|runtime|provider|model|memory_revision_pending)/iu.test(
    `${code} ${message}`,
  );
}
