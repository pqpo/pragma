import { createHash } from "node:crypto";

import { StaticContextStore } from "@pragma/core";
import {
  SkillExtractionInputSchema,
  SkillExtractionOutputSchema,
  type ExistingMemorySkillTarget,
  type MemoryEvidenceEnvelope,
  type MemorySubjectRef,
  type SkillExtractionCandidate,
  type SkillSourceSnapshot,
} from "@pragma/shared";

import type { MemoryModule } from "../pipeline/memory-module.ts";
import { extractionErrorCode } from "../pipeline/extraction-error-code.ts";
import { DEFAULT_MEMORY_STORAGE_POLICY } from "../storage/memory-storage-policy.ts";
import type { SkillMemoryExtractor } from "./schema.ts";
import type { SkillSourceReader } from "./source-reader.ts";
import { createSkillLearningStore, type SkillLearningStore } from "./store.ts";

const MAX_SOURCE_REVISIONS = 100;

export interface SkillLearningTargetReader {
  listTargets(input: { readonly expertRef: string }): Promise<readonly ExistingMemorySkillTarget[]>;
}

export interface SkillLearningSink {
  submit(input: {
    readonly rootRef: MemorySubjectRef;
    readonly sourceDigest: string;
    readonly candidates: readonly SkillExtractionCandidate[];
    readonly sources: readonly SkillSourceSnapshot[];
  }): Promise<void>;
}

export interface SkillMemoryModule extends MemoryModule {
  readonly store: SkillLearningStore;
  setExtractor(extractor: SkillMemoryExtractor | undefined): Promise<void>;
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
  readonly extractor?: SkillMemoryExtractor;
  readonly now?: () => Date;
}): Promise<SkillMemoryModule> {
  const store = await createSkillLearningStore(options);
  const now = options.now ?? (() => new Date());
  let extractor = options.extractor;
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
      if (extractor === undefined) return;
      const job = await store.claimDueJob(now());
      if (job === undefined) return;
      const controller = new AbortController();
      running.set(job.id, controller);
      let retained = false;
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
        if (!skillSourceThresholdMet(sources)) {
          await store.complete(job, "rejected", now());
          return;
        }
        const expertRefs = producerExpertRefs(job.rootRef, sources);
        if (expertRefs.length === 0) {
          await store.complete(job, "rejected", now());
          return;
        }
        for (const expertRef of expertRefs) {
          const existingTargets = await options.targetReader.listTargets({ expertRef });
          const input = SkillExtractionInputSchema.parse({
            schemaVersion: "pragma.memory-skill-extraction-input/v1",
            jobId: job.id,
            rootRef: job.rootRef,
            sources: sourcesForExpert(sources, expertRef),
            existingTargets,
          });
          if (!(await store.isClaimCurrent(job))) return;
          controller.signal.throwIfAborted();
          const result = await extractor.extract(input, { signal: controller.signal });
          const output = SkillExtractionOutputSchema.parse(result.output);
          if (!output.retain) continue;
          const candidates = eligibleCandidates(output.candidates, input.sources, existingTargets);
          if (candidates.length === 0) continue;
          await options.learningSink.submit({
            rootRef: job.rootRef,
            sourceDigest,
            candidates,
            sources: input.sources,
          });
          retained = true;
        }
        await store.complete(job, retained ? "retained" : "rejected", now());
      } catch (error) {
        await store.fail({
          job,
          errorCode: extractionErrorCode(error, "skill_extraction"),
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

export function skillSourceThresholdMet(sources: readonly SkillSourceSnapshot[]): boolean {
  const currentEpisodes = new Map<string, SkillSourceSnapshot>();
  for (const source of sources) {
    if (source.ref.kind !== "episodic") continue;
    const current = currentEpisodes.get(source.ref.id);
    if (current === undefined || source.ref.revision > current.ref.revision) {
      currentEpisodes.set(source.ref.id, source);
    }
  }
  const episodes = [...currentEpisodes.values()].filter(
    (source) => (source.valueScore ?? 0) >= 0.85,
  );
  const conversations = new Set(
    episodes
      .map((source) =>
        source.conversationRef === undefined
          ? undefined
          : `${source.conversationRef.type}\0${source.conversationRef.id}`,
      )
      .filter(Boolean),
  );
  const successful = episodes.filter(
    (source) => source.outcome === "succeeded" || source.hasSuccessfulRecovery,
  );
  return episodes.length >= 3 && conversations.size >= 2 && successful.length >= 2;
}

function eligibleCandidates(
  candidates: readonly SkillExtractionCandidate[],
  sources: readonly SkillSourceSnapshot[],
  targets: readonly ExistingMemorySkillTarget[],
): readonly SkillExtractionCandidate[] {
  const available = new Map(sources.map((source) => [sourceKey(source), source]));
  const targetIds = new Set(targets.map((target) => target.bindingId));
  const normalizedKeys = new Set<string>();
  return candidates.filter((candidate) => {
    const selected = candidate.sourceRefs.map((ref) =>
      available.get(`${ref.kind}\0${ref.id}\0${ref.revision}`),
    );
    if (!selected.every((source): source is SkillSourceSnapshot => source !== undefined)) {
      return false;
    }
    if (!skillSourceThresholdMet(selected)) return false;
    const bindingIds =
      candidate.route.type === "revise"
        ? [candidate.route.bindingId]
        : candidate.route.type === "ambiguous"
          ? candidate.route.bindingIds
          : [];
    if (bindingIds.some((id) => !targetIds.has(id))) return false;
    if (normalizedKeys.has(candidate.content.normalizedKey)) return false;
    normalizedKeys.add(candidate.content.normalizedKey);
    return true;
  });
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
  const selected: SkillSourceSnapshot[] = [];
  for (const source of sources.slice(0, MAX_SOURCE_REVISIONS)) {
    if (
      Buffer.byteLength(JSON.stringify([...selected, source])) >
      DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes
    )
      break;
    selected.push(source);
  }
  return selected;
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
  return /(?:unavailable|not configured|profile|runtime|provider|model)/iu.test(
    error instanceof Error ? error.message : String(error),
  );
}
