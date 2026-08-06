import { createHash } from "node:crypto";
import { StaticContextStore } from "@pragma/core";

import {
  KnowledgeExtractionInputSchema,
  KnowledgeExtractionOutputSchema,
  type KnowledgeExtractionCandidate,
  type KnowledgeSourceSnapshot,
  type MemorySubjectRef,
} from "@pragma/shared";

import type { KnowledgeMemoryExtractor, KnowledgeSourceReader } from "./schema.ts";
import { createKnowledgeLearningStore, type KnowledgeLearningStore } from "./store.ts";
import { extractionErrorCode } from "../pipeline/extraction-error-code.ts";
import type { MemoryModule } from "../pipeline/memory-module.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";

const MAX_SOURCE_REVISIONS = 100;

export {
  KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION,
  type KnowledgeMemoryExtractor,
  type KnowledgeSourceReader,
} from "./schema.ts";

export interface KnowledgeMemoryModule extends MemoryModule {
  readonly store: KnowledgeLearningStore;
  setExtractor(extractor: KnowledgeMemoryExtractor | undefined): Promise<void>;
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
    readonly sourceDigest: string;
    readonly candidates: readonly KnowledgeExtractionCandidate[];
    readonly sources: readonly KnowledgeSourceSnapshot[];
  }): Promise<void>;
}

export async function createKnowledgeMemoryModule(options: {
  readonly sourceReader: KnowledgeSourceReader;
  readonly pragmaHome?: string | undefined;
  readonly extractor?: KnowledgeMemoryExtractor | undefined;
  readonly learningSink: KnowledgeLearningSink;
  readonly now?: (() => Date) | undefined;
}): Promise<KnowledgeMemoryModule> {
  const store = await createKnowledgeLearningStore(options);
  const now = options.now ?? (() => new Date());
  let extractor = options.extractor;
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
          "Knowledge learning only proposes Studio Context Store initialization or revision tasks. It has no recallable published projection.",
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
      if (extractor === undefined) return;
      const job = await store.claimDueJob(now());
      if (job === undefined) return;
      const controller = new AbortController();
      running.set(job.id, controller);
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
        const input = KnowledgeExtractionInputSchema.parse({
          schemaVersion: "pragma.memory-knowledge-extraction-input/v2",
          jobId: job.id,
          rootRef: job.rootRef,
          sources,
        });
        if (!(await store.isClaimCurrent(job))) return;
        controller.signal.throwIfAborted();
        const result = await extractor.extract(input, { signal: controller.signal });
        controller.signal.throwIfAborted();
        const output = KnowledgeExtractionOutputSchema.parse(result.output);
        if (!output.retain) {
          await store.completeRejected(job, now());
          return;
        }
        assertEligibleCandidates(output.candidates, sources);
        await options.learningSink.submit({
          rootRef: job.rootRef,
          sourceDigest,
          candidates: output.candidates,
          sources,
        });
        await store.completeLearned(job, now());
      } catch (error) {
        await store.fail({
          job,
          errorCode: extractionErrorCode(error, "knowledge_extraction"),
          retry: isConfigurationError(error) ? "configuration" : "transient",
          now: now(),
        });
      } finally {
        if (running.get(job.id) === controller) running.delete(job.id);
      }
    },
    async setExtractor(next) {
      extractor = next;
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
      DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes
    ) {
      break;
    }
    selected.push(source);
  }
  return selected;
}

function assertEligibleCandidates(
  candidates: readonly KnowledgeExtractionCandidate[],
  sources: readonly KnowledgeSourceSnapshot[],
): void {
  const available = new Map(sources.map((source) => [sourceKey(source), source]));
  const normalizedKeys = new Set<string>();
  for (const candidate of candidates) {
    if (normalizedKeys.has(candidate.content.normalizedKey)) {
      throw new Error("knowledge_normalized_key_duplicate");
    }
    normalizedKeys.add(candidate.content.normalizedKey);
    const selected = [
      ...new Map(
        candidate.sourceRefs.map((ref) => {
          const source = available.get(`${ref.kind}\0${ref.id}\0${ref.revision}`);
          if (source === undefined) throw new Error("knowledge_source_ref_invalid");
          return [sourceKey(source), source] as const;
        }),
      ).values(),
    ];
    if (!knowledgeSourceSelectionEligible(selected)) {
      throw new Error("knowledge_source_threshold_not_met");
    }
  }
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

/** Distinguishes exact source revisions when validating extractor references. */
function sourceKey(source: KnowledgeSourceSnapshot): string {
  return `${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`;
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
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unavailable|not configured|profile|runtime|provider|model)/i.test(message);
}
