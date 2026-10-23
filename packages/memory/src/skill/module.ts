import {
  SkillLearningPlanSchema,
  MEMORY_LEARNING_POLICY_VERSION,
} from "../learning/revision-plan.ts";
import { createLearningDecisionStore, learningFingerprint } from "../learning/decision-store.ts";
import { createHash } from "node:crypto";

import { StaticContextStore } from "@pragma/core";
import {
  SkillSourceSnapshotSchema,
  type ExistingMemorySkillTarget,
  type MemoryEvidenceEnvelope,
  type MemoryExtractionFailurePhase,
  type MemorySubjectRef,
  type SkillSourceSnapshot,
} from "@pragma/shared";

import type { MemoryModule } from "../pipeline/memory-module.ts";
import { extractionFailureDiagnostic } from "../pipeline/extraction-error-code.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import type { SkillSourceReader } from "./source-reader.ts";
import { createSkillLearningStore, type SkillLearningStore } from "./store.ts";
import {
  inspectSkillLearningPlan,
  qualifyingSkillLearningPlan,
  skillSourceThresholdMet,
  type SkillPlanValidationIssue,
} from "./validation.ts";
import type { SkillLearningPlan } from "../learning/revision-plan.ts";
import { createMemoryLearningPolicyGuard } from "../learning/learning-policy.ts";
import { writeMemoryLearningTaskPresentation } from "../learning/task-presentation.ts";

const MAX_SOURCE_REVISIONS =
  DEFAULT_MEMORY_STORAGE_POLICY.episodicMaxRecords +
  DEFAULT_MEMORY_STORAGE_POLICY.semanticMaxRecords;

export interface SkillLearningTargetReader {
  readTargetFile?(target: ExistingMemorySkillTarget, path: string): Promise<string>;
  readTarget?(target: ExistingMemorySkillTarget): Promise<string>;
  listTargets(input: { readonly expertRef: string }): Promise<readonly ExistingMemorySkillTarget[]>;
}

export interface SkillLearningSink {
  assertAvailable?(input: {
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly plan: Extract<SkillLearningPlan, { action: "apply" }>;
  }): Promise<void>;
  submit(input: {
    readonly rootRef: MemorySubjectRef;
    readonly sourceDigest: string;
    readonly expertRef: string;
    readonly plan: Extract<SkillLearningPlan, { action: "apply" }>;
    readonly sources: readonly SkillSourceSnapshot[];
  }): Promise<void>;
}

export interface SkillLearningPlanner {
  plan(input: {
    readonly rootRef: MemorySubjectRef;
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly sources: readonly SkillSourceSnapshot[];
    readonly existingTargets: readonly ExistingMemorySkillTarget[];
    readonly readTarget?: ((target: ExistingMemorySkillTarget) => Promise<string>) | undefined;
    readonly readTargetFile?:
      ((target: ExistingMemorySkillTarget, path: string) => Promise<string>) | undefined;
    readonly signal: AbortSignal;
    readonly onRejectedChanges?: (issues: readonly SkillPlanValidationIssue[]) => void;
  }): Promise<SkillLearningPlan>;
}

export interface SkillMemoryModule extends MemoryModule {
  readonly store: SkillLearningStore;
  scheduleRoot(rootRef: MemorySubjectRef): Promise<void>;
  setPlanner(planner: SkillLearningPlanner | undefined): Promise<void>;
  interruptExtractionJob(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: Date;
  }): Promise<void>;
  close(): void;
}

export async function createSkillMemoryModule(options: {
  readonly sourceReader: SkillSourceReader;
  readonly targetReader: SkillLearningTargetReader;
  readonly learningSink: SkillLearningSink;
  readonly pragmaHome?: string;
  readonly planner?: SkillLearningPlanner;
  readonly now?: () => Date;
}): Promise<SkillMemoryModule> {
  const store = await createSkillLearningStore(options);
  const now = options.now ?? (() => new Date());
  let decisions: ReturnType<typeof createLearningDecisionStore>;
  try {
    decisions = createLearningDecisionStore(options, "skill");
  } catch (error) {
    store.close();
    throw error;
  }
  const canLearn = createMemoryLearningPolicyGuard({ ...options, now });
  let planner = options.planner;
  const running = new Map<string, AbortController>();
  const scheduleRoot = async (rootRef: MemorySubjectRef): Promise<void> => {
    if (!(await canLearn(rootRef))) return;
    const sources = boundSources(
      await options.sourceReader.listEligibleSources({
        rootRef,
        limit: MAX_SOURCE_REVISIONS,
        now: now(),
      }),
    );
    const sourceDigest = digest(
      "skill-sources",
      MEMORY_LEARNING_POLICY_VERSION,
      ...sources.map(sourceKey).toSorted(),
    );
    const job = await store.schedule({
      rootRef,
      sourceDigest,
      now: now(),
      deferUntil: new Date(now().getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs),
    });
    if (job !== undefined)
      writeMemoryLearningTaskPresentation(options, { module: "skill", ...job }, { sources });
  };
  return {
    scheduleRoot,
    descriptor: {
      id: "pragma.memory.skill-learning",
      version: "1.0.0",
      pathPrefix: "skill-learning",
      storageModel: "immutable-revision",
      purpose: "learning",
      contextLayers: {
        usagePrompt:
          "Skill learning proposes reviewed Skill Capability initialization or revision tasks and has no recallable projection.",
        summaryPath: "summary.md",
        indexPath: "index.md",
        itemsPrefix: "items/",
        evidencePrefix: "evidence/",
        summaryMaxBytes: 2_048,
        indexMaxBytes: 4_096,
      },
    },
    subscriptions: [
      {
        topic: "execution.execution.terminal",
        schemaRefs: ["pragma.memory.execution-terminal/v2"],
      },
    ],
    createContextProvider() {
      return new StaticContextStore();
    },
    async consume(envelopes) {
      for (const [rootKey, group] of groupTerminalSignals(envelopes)) {
        if (!(await canLearn(group[0]!.attribution!.rootRef))) continue;
        try {
          await scheduleRoot(group[0]!.attribution!.rootRef);
        } catch {
          // Source delivery must remain recoverable even when its projections cannot be read yet.
          await store.schedule({
            rootRef: group[0]!.attribution!.rootRef,
            sourceDigest: digest(
              "terminal-signal",
              rootKey,
              ...group.map((item) => item.messageId).toSorted(),
            ),
            now: now(),
            deferUntil: new Date(now().getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs),
          });
        }
      }
      return {};
    },
    async runBackgroundOnce() {
      if (!(await canLearn())) return;
      if (planner === undefined) return;
      const job = await store.claimDueJob(now());
      if (job === undefined) return;
      const controller = new AbortController();
      running.set(job.id, controller);
      let retained = false;
      const rejectedChanges: { expertRef: string; index: number; message: string }[] = [];
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
        const sourceDigest = digest(
          "skill-sources",
          MEMORY_LEARNING_POLICY_VERSION,
          ...sources.map(sourceKey).toSorted(),
        );
        if (job.sourceDigest !== sourceDigest) {
          const next = await store.schedule({ rootRef: job.rootRef, sourceDigest, now: now() });
          if (next !== undefined)
            writeMemoryLearningTaskPresentation(options, { module: "skill", ...next }, { sources });
          await store.complete(job, "rejected", now());
          return;
        }
        const expertRefs = producerExpertRefs(job.rootRef, sources);
        writeMemoryLearningTaskPresentation(options, { module: "skill", ...job }, { sources });
        if (expertRefs.length === 0) {
          await store.complete(job, "rejected", now());
          return;
        }
        const eligibleExpertSources = expertRefs
          .map((expertRef) => ({
            expertRef,
            sources: sourcesForExpert(sources, expertRef),
          }))
          .filter(({ sources: expertSources }) => skillSourceThresholdMet(expertSources));
        if (eligibleExpertSources.length === 0) {
          await store.complete(job, "rejected", now());
          return;
        }
        for (const { expertRef, sources: expertSources } of eligibleExpertSources) {
          const producers = expertSources.flatMap((source) => source.producerRefs);
          if (!(await canLearn(job.rootRef, producers))) {
            await store.interruptJob({ id: job.id, expectedRevision: job.revision, now: now() });
            return;
          }
          phase = "target_read";
          const existingTargets = await options.targetReader.listTargets({ expertRef });
          if (!(await store.isClaimCurrent(job))) return;
          controller.signal.throwIfAborted();
          // Skill targets are chosen by the planner; unrelated pending targets must not
          // prevent this expert from proposing independent Skill work.
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
          phase = "revision_plan";
          const cachedPlan = decisions.readPlan(evaluationKey);
          modelRequested ||= cachedPlan === undefined;
          const proposedPlan =
            cachedPlan === undefined
              ? await planner.plan({
                  rootRef: job.rootRef,
                  expertRef,
                  sourceDigest,
                  sources: expertSources,
                  existingTargets,
                  readTarget: options.targetReader.readTarget,
                  readTargetFile: options.targetReader.readTargetFile,
                  signal: controller.signal,
                  onRejectedChanges: (issues) => {
                    rejectedChanges.push(...issues.map((issue) => ({ expertRef, ...issue })));
                  },
                })
              : SkillLearningPlanSchema.parse(cachedPlan);
          if (cachedPlan !== undefined && proposedPlan.action === "apply")
            for (const change of proposedPlan.changes)
              change.sourceRefs = change.sourceRefs.map(
                (ref) =>
                  expertSources.find(
                    (source) => source.ref.kind === ref.kind && source.ref.id === ref.id,
                  )?.ref ?? ref,
              );
          if (!(await canLearn(job.rootRef, producers))) {
            await store.interruptJob({ id: job.id, expectedRevision: job.revision, now: now() });
            return;
          }
          controller.signal.throwIfAborted();
          if (!(await store.isClaimCurrent(job))) return;
          const latest = boundSources(
            await options.sourceReader.listEligibleSources({
              rootRef: job.rootRef,
              limit: MAX_SOURCE_REVISIONS,
              now: now(),
            }),
          );
          if (
            digest(
              "skill-sources",
              MEMORY_LEARNING_POLICY_VERSION,
              ...latest.map(sourceKey).toSorted(),
            ) !== job.sourceDigest
          ) {
            await store.schedule({
              rootRef: job.rootRef,
              sourceDigest: digest(
                "skill-sources",
                MEMORY_LEARNING_POLICY_VERSION,
                ...latest.map(sourceKey).toSorted(),
              ),
              now: now(),
              deferUntil: new Date(
                now().getTime() + DEFAULT_MEMORY_STORAGE_POLICY.extractionIdleMs,
              ),
            });
            await store.complete(job, "rejected", now());
            return;
          }
          phase = "validation";
          rejectedChanges.push(
            ...inspectSkillLearningPlan(proposedPlan, expertSources, existingTargets).map(
              (issue) => ({ expertRef, ...issue }),
            ),
          );
          const plan = qualifyingSkillLearningPlan(proposedPlan, expertSources, existingTargets);
          if (plan.action === "skip") {
            if (plan.waitForTarget !== undefined) {
              if (
                !existingTargets.some(
                  (target) => target.capabilityId === plan.waitForTarget && target.pending,
                )
              )
                throw Object.assign(new Error("memory_learning_invalid_wait_target"), {
                  retryable: false,
                });
              decisions.writePlan(evaluationKey, plan);
              throw new Error("memory_revision_pending");
            }
            decisions.write(evaluationKey, job.id, {
              outcome: rejectedChanges.some((issue) => issue.expertRef === expertRef)
                ? "unsupported"
                : (plan.disposition ?? "accumulate"),
              reason:
                plan.reason ??
                (rejectedChanges.some((issue) => issue.expertRef === expertRef)
                  ? rejectedChanges
                      .filter((issue) => issue.expertRef === expertRef)
                      .map((issue) => issue.message)
                      .join("\n")
                      .slice(0, 4000)
                  : "No supported incremental change."),
              targets: [],
            });
            continue;
          }
          if (cachedPlan === undefined) decisions.writePlan(evaluationKey, plan);
          const proposalKey = learningFingerprint({
            expertRef,
            changes: plan.changes.map((change) => ({
              normalizedKey: change.normalizedKey,
              target: change.target,
              targetFiles: change.targetFiles,
              sourceRefs: change.sourceRefs,
            })),
            sources: expertSources.filter((source) =>
              plan.changes.some((change) =>
                change.sourceRefs.some(
                  (ref) => ref.kind === source.ref.kind && ref.id === source.ref.id,
                ),
              ),
            ),
          });
          if (decisions.has(proposalKey)) {
            decisions.write(evaluationKey, job.id, {
              outcome: "duplicate",
              reason: "The same supported workflow was already submitted for review.",
              targets: plan.changes.map((item) => item.name),
            });
            continue;
          }
          writeMemoryLearningTaskPresentation(
            options,
            { module: "skill", ...job },
            { sources, plannedTitles: plan.changes.map((change) => change.name) },
          );
          phase = "revision_submit";
          await options.learningSink.assertAvailable?.({
            expertRef,
            sourceDigest: proposalKey,
            plan,
          });
          controller.signal.throwIfAborted();
          if (!(await store.isClaimCurrent(job))) return;
          await options.learningSink.submit({
            rootRef: job.rootRef,
            sourceDigest: proposalKey,
            expertRef,
            plan,
            sources: expertSources,
          });
          const decision = {
            outcome: plan.changes.some((item) => item.target.type === "create")
              ? ("create" as const)
              : ("revise" as const),
            reason: plan.changes.map((item) => item.description).join("\n"),
            targets: plan.changes.map((item) => item.name),
          };
          decisions.write(proposalKey, job.id, decision);
          decisions.write(evaluationKey, job.id, decision);
          retained = true;
        }
        const completedAt = now();
        await store.complete(
          job,
          retained ? "retained" : "rejected",
          completedAt,
          rejectedChanges.length === 0
            ? undefined
            : extractionFailureDiagnostic(
                Object.assign(new Error(JSON.stringify(rejectedChanges)), {
                  code: "skill_learning_plan_rejected",
                  retryable: false,
                }),
                "skill_extraction",
                { phase: "validation", startedAt, now: completedAt },
              ).diagnostic,
        );
      } catch (error) {
        const failure = extractionFailureDiagnostic(error, "skill_extraction", {
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
    async setPlanner(next) {
      planner = next;
    },
    async interruptExtractionJob(input) {
      const job = await store.interruptJob(input);
      running.get(job.id)?.abort();
    },
    store,
    close() {
      decisions.close();
      store.close();
    },
  };
}

function groupTerminalSignals(
  envelopes: readonly MemoryEvidenceEnvelope[],
): ReadonlyMap<string, readonly MemoryEvidenceEnvelope[]> {
  const groups = new Map<string, MemoryEvidenceEnvelope[]>();
  for (const envelope of envelopes) {
    const root = envelope.attribution?.rootRef;
    if (
      envelope.topic !== "execution.execution.terminal" ||
      root === undefined ||
      !["pragma.expert", "pragma.expert-team", "pragma.flow"].includes(root.type)
    )
      continue;
    const key = `${root.type}\0${root.id}`;
    groups.set(key, [...(groups.get(key) ?? []), envelope]);
  }
  return groups;
}

function boundSources(sources: readonly SkillSourceSnapshot[]): readonly SkillSourceSnapshot[] {
  return sources
    .filter((source) => SkillSourceSnapshotSchema.safeParse(source).success)
    .slice(0, MAX_SOURCE_REVISIONS);
}

function producerExpertRefs(
  rootRef: MemorySubjectRef,
  sources: readonly SkillSourceSnapshot[],
): readonly string[] {
  const refs = sources
    .flatMap((source) => source.producerRefs)
    .filter((ref) => ref.type === "pragma.expert")
    .map((ref) => `expert:${ref.id}`);
  if (refs.length === 0 && rootRef.type === "pragma.expert") refs.push(`expert:${rootRef.id}`);
  return [...new Set(refs)].toSorted();
}
function sourcesForExpert(
  sources: readonly SkillSourceSnapshot[],
  expertRef: string,
): readonly SkillSourceSnapshot[] {
  const id = expertRef.slice("expert:".length);
  return sources.filter(
    (source) =>
      source.producerRefs.some((ref) => ref.type === "pragma.expert" && ref.id === id) ||
      (source.rootRef.type === "pragma.expert" && source.rootRef.id === id),
  );
}
function sourceKey(source: SkillSourceSnapshot): string {
  return `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`;
}
function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
function isConfigurationError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return /(?:unavailable|not configured|profile|runtime|provider|model|memory_revision_pending)/iu.test(
    `${code} ${error instanceof Error ? error.message : String(error)}`,
  );
}
