import { createHash } from "node:crypto";
import { StaticContextStore } from "@pragma/core";

import {
  type KnowledgeSourceSnapshot,
  type MemoryExtractionFailurePhase,
  type MemorySubjectRef,
} from "@pragma/shared";

import type { KnowledgeSourceReader } from "./schema.ts";
import { createKnowledgeLearningStore, type KnowledgeLearningStore } from "./store.ts";
import { extractionFailureDiagnostic } from "../pipeline/extraction-error-code.ts";
import type { MemoryModule } from "../pipeline/memory-module.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import type { KnowledgeLearningPlan } from "../learning/revision-plan.ts";

const MAX_SOURCE_REVISIONS = 100;

export type { KnowledgeSourceReader } from "./schema.ts";

export interface KnowledgeMemoryModule extends MemoryModule {
  readonly store: KnowledgeLearningStore;
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
  submit(input: {
    readonly rootRef: MemorySubjectRef;
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly plan: Extract<KnowledgeLearningPlan, { action: "apply" }>;
    readonly sources: readonly KnowledgeSourceSnapshot[];
  }): Promise<void>;
}

export interface KnowledgeLearningPlanner {
  plan(input: {
    readonly rootRef: MemorySubjectRef;
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly sources: readonly KnowledgeSourceSnapshot[];
    readonly signal: AbortSignal;
  }): Promise<KnowledgeLearningPlan>;
}

export async function createKnowledgeMemoryModule(options: {
  readonly sourceReader: KnowledgeSourceReader;
  readonly pragmaHome?: string | undefined;
  readonly planner?: KnowledgeLearningPlanner | undefined;
  readonly learningSink: KnowledgeLearningSink;
  readonly now?: (() => Date) | undefined;
}): Promise<KnowledgeMemoryModule> {
  const store = await createKnowledgeLearningStore(options);
  const now = options.now ?? (() => new Date());
  let planner = options.planner;
  const running = new Map<string, AbortController>();

  const scheduleRoot = async (rootRef: MemorySubjectRef): Promise<void> => {
    const sources = boundSources(
      await options.sourceReader.listEligibleSources({
        rootRef,
        limit: MAX_SOURCE_REVISIONS,
        now: now(),
      }),
    );
    if (sources.length === 0) return;
    await store.schedule({
      rootRef,
      sourceDigest: digest("knowledge-sources", ...sources.map(sourceDigestKey).toSorted()),
      now: now(),
    });
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
      if (planner === undefined) return;
      const job = await store.claimDueJob(now());
      if (job === undefined) return;
      const controller = new AbortController();
      running.set(job.id, controller);
      const startedAt = now();
      let phase: MemoryExtractionFailurePhase = "source_read";
      try {
        const available = await options.sourceReader.listEligibleSources({
          rootRef: job.rootRef,
          limit: MAX_SOURCE_REVISIONS,
          now: now(),
        });
        const sources = boundSources(available);
        if (sources.length === 0) {
          await store.completeRejected(job, now());
          return;
        }
        const sourceDigest = digest(
          "knowledge-sources",
          ...sources.map(sourceDigestKey).toSorted(),
        );
        if (job.sourceDigest !== sourceDigest) {
          await store.completeRejected(job, now());
          return;
        }
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
          if (!(await store.isClaimCurrent(job))) return;
          controller.signal.throwIfAborted();
          const expertDigest = digest(
            "knowledge-expert-sources",
            expertRef,
            ...expertSources.map(sourceDigestKey).toSorted(),
          );
          phase = "revision_plan";
          const plan = await planner.plan({
            rootRef: job.rootRef,
            expertRef,
            sourceDigest: expertDigest,
            sources: expertSources,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (plan.action === "skip") continue;
          phase = "revision_submit";
          await options.learningSink.submit({
            rootRef: job.rootRef,
            expertRef,
            sourceDigest: expertDigest,
            plan,
            sources: expertSources,
          });
          submitted = true;
        }
        if (submitted) await store.completeLearned(job, now());
        else await store.completeRejected(job, now());
      } catch (error) {
        const failure = extractionFailureDiagnostic(error, "knowledge_extraction", {
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
    scheduleRoot,
    async interruptExtractionJob(input) {
      const interrupted = await store.interruptJob(input);
      running.get(interrupted.id)?.abort();
    },
    store,
    close() {
      store.close();
    },
  };
}

function boundSources(
  sources: readonly KnowledgeSourceSnapshot[],
): readonly KnowledgeSourceSnapshot[] {
  const selected: KnowledgeSourceSnapshot[] = [];
  for (const source of sources.slice(0, MAX_SOURCE_REVISIONS)) {
    const next = [...selected, source];
    if (
      Buffer.byteLength(JSON.stringify(next)) >
      Math.min(DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes, 35_000)
    )
      continue;
    selected.push(source);
  }
  return selected;
}

export function knowledgeSourceSelectionEligible(
  sources: readonly KnowledgeSourceSnapshot[],
): boolean {
  const semantic = sources.filter((source) => source.ref.kind === "semantic");
  return (
    semantic.some((source) => source.verified) ||
    new Set(semantic.flatMap((source) => source.sourceExecutionIds)).size >= 2
  );
}

/** Detects effective source-content changes while ignoring revision-only churn. */
function sourceDigestKey(source: KnowledgeSourceSnapshot): string {
  return JSON.stringify({
    kind: source.ref.kind,
    id: source.ref.id,
    producerRefs: source.producerRefs,
    sourceExecutionIds: source.sourceExecutionIds,
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
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unavailable|not configured|profile|runtime|provider|model|memory_revision_pending)/iu.test(
    `${code} ${message}`,
  );
}
