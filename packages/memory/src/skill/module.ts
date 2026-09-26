import { createHash } from "node:crypto";

import { StaticContextStore } from "@pragma/core";
import {
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
import { skillSourceThresholdMet } from "./validation.ts";
import type { SkillLearningPlan } from "../learning/revision-plan.ts";

const MAX_SOURCE_REVISIONS = 100;

export interface SkillLearningTargetReader {
  listTargets(input: { readonly expertRef: string }): Promise<readonly ExistingMemorySkillTarget[]>;
}

export interface SkillLearningSink {
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
    readonly signal: AbortSignal;
  }): Promise<SkillLearningPlan>;
}

export interface SkillMemoryModule extends MemoryModule {
  readonly store: SkillLearningStore;
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
  let planner = options.planner;
  const running = new Map<string, AbortController>();
  return {
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
        await store.schedule({
          rootRef: group[0]!.attribution!.rootRef,
          sourceDigest: digest(
            "terminal-signal",
            rootKey,
            ...group.map((item) => item.messageId).toSorted(),
          ),
          now: now(),
        });
      }
      return {};
    },
    async runBackgroundOnce() {
      if (planner === undefined) return;
      const job = await store.claimDueJob(now());
      if (job === undefined) return;
      const controller = new AbortController();
      running.set(job.id, controller);
      let retained = false;
      const startedAt = now();
      let phase: MemoryExtractionFailurePhase = "source_read";
      try {
        const available = await options.sourceReader.listEligibleSources({
          rootRef: job.rootRef,
          limit: MAX_SOURCE_REVISIONS,
          now: now(),
        });
        const sources = boundSources(available);
        const sourceDigest = digest("skill-sources", ...sources.map(sourceKey).toSorted());
        if (job.sourceDigest !== sourceDigest) {
          await store.schedule({ rootRef: job.rootRef, sourceDigest, now: now() });
          await store.complete(job, "rejected", now());
          return;
        }
        const expertRefs = producerExpertRefs(job.rootRef, sources);
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
          phase = "target_read";
          const existingTargets = await options.targetReader.listTargets({ expertRef });
          if (!(await store.isClaimCurrent(job))) return;
          controller.signal.throwIfAborted();
          phase = "revision_plan";
          const plan = await planner.plan({
            rootRef: job.rootRef,
            expertRef,
            sourceDigest,
            sources: expertSources,
            existingTargets,
            signal: controller.signal,
          });
          phase = "validation";
          if (plan.action === "skip") continue;
          if (
            new Set(plan.changes.map((change) => change.normalizedKey)).size !== plan.changes.length
          ) {
            throw new Error("skill_learning_plan_duplicate_key");
          }
          const available = new Map(expertSources.map((source) => [sourceKey(source), source]));
          const valid = plan.changes.every((change) => {
            const selected = change.sourceRefs.map((ref) =>
              available.get(`${ref.kind}\0${ref.id}\0${ref.revision}`),
            );
            const selectedTarget = change.target;
            const targetAllowed =
              selectedTarget.type === "create"
                ? !existingTargets.some((target) =>
                    target.normalizedKeys.includes(change.normalizedKey),
                  )
                : existingTargets.some(
                    (target) =>
                      target.capabilityId === selectedTarget.capabilityId &&
                      target.normalizedKeys.includes(change.normalizedKey),
                  );
            return (
              selected.every((source) => source !== undefined) &&
              skillSourceThresholdMet(selected as SkillSourceSnapshot[]) &&
              targetAllowed
            );
          });
          if (!valid) throw new Error("skill_learning_plan_invalid");
          phase = "revision_submit";
          await options.learningSink.submit({
            rootRef: job.rootRef,
            sourceDigest,
            expertRef,
            plan,
            sources: expertSources,
          });
          retained = true;
        }
        await store.complete(job, retained ? "retained" : "rejected", now());
      } catch (error) {
        const failure = extractionFailureDiagnostic(error, "skill_extraction", {
          phase,
          startedAt,
          now: now(),
        });
        await store.fail({
          job,
          ...failure,
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
  const candidates = sources
    .map((source, index) => ({ source, index }))
    .toSorted(
      (left, right) =>
        sourcePriority(left.source) - sourcePriority(right.source) || left.index - right.index,
    )
    .slice(0, MAX_SOURCE_REVISIONS);
  const selected: Array<{ readonly source: SkillSourceSnapshot; readonly index: number }> = [];
  for (const candidate of candidates) {
    if (
      Buffer.byteLength(
        JSON.stringify([...selected.map((item) => item.source), candidate.source]),
      ) > Math.min(DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes, 35_000)
    )
      continue;
    selected.push(candidate);
  }
  return selected.toSorted((left, right) => left.index - right.index).map((item) => item.source);
}

function sourcePriority(source: SkillSourceSnapshot): number {
  if (source.ref.kind === "episodic" && (source.valueScore ?? 0) >= 0.85) return 0;
  if (source.ref.kind === "episodic") return 1;
  return 2;
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
