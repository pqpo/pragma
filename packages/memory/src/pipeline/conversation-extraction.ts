import type { EpisodicMemoryExtractor } from "../episodic/schema.ts";
import type { SemanticMemoryExtractor } from "../semantic/schema.ts";
import type { EpisodicMemoryModule } from "../episodic/module.ts";
import type { SemanticMemoryModule } from "../semantic/module.ts";
import type { PreparedMemoryExtraction } from "./prepare-extraction.ts";
import { createHash } from "node:crypto";
import type { MemorySubjectRef } from "@pragma/shared";
import { PragmaPaths, withFileLock } from "@pragma/core";
import { join } from "node:path";

export function conversationExtractionJobId(ref: MemorySubjectRef, watermark: string): string {
  return `conversation-${createHash("sha256")
    .update(JSON.stringify([ref, watermark]))
    .digest("hex")
    .slice(0, 24)}`;
}

type Prepared<Extractor extends EpisodicMemoryExtractor | SemanticMemoryExtractor> =
  PreparedMemoryExtraction<
    Parameters<Extractor["extract"]>[0],
    Awaited<ReturnType<Extractor["extract"]>>
  >;
export interface ConversationExtractionBatch {
  readonly episodic?: Prepared<EpisodicMemoryExtractor> | undefined;
  readonly semantic?: Prepared<SemanticMemoryExtractor> | undefined;
}
export interface ConversationMemoryExtractor {
  extract(batch: ConversationExtractionBatch): Promise<void>;
}

/** The only admission owner of shared Curator work. Module claims are delivery acknowledgements. */
export function createConversationMemoryExtractionCoordinator(options: {
  pragmaHome: string;
  episodic: Pick<EpisodicMemoryModule, "prepareBackgroundOnce" | "store">;
  semantic: Pick<SemanticMemoryModule, "prepareBackgroundOnce" | "store">;
  now?: (() => Date) | undefined;
}) {
  let extractor: ConversationMemoryExtractor | undefined;
  let running: Promise<void> | undefined;
  const nextConversation = async (now: Date): Promise<MemorySubjectRef | undefined> => {
    const [episodic, semantic] = await Promise.all([
      options.episodic.store.listExtractionJobs(),
      options.semantic.store.listExtractionJobs(),
    ]);
    const unfinished = (job: (typeof episodic)[number] | (typeof semantic)[number]) =>
      job.status !== "completed" && job.status !== "expired";
    const key = (ref: MemorySubjectRef) => JSON.stringify([ref.type, ref.id]);
    const peers = [episodic, semantic].map(
      (jobs) => new Set(jobs.filter(unfinished).map((job) => key(job.conversationRef))),
    );
    const candidates = [...episodic, ...semantic]
      .filter((job) => unfinished(job) && job.status !== "needs_attention")
      .toSorted((a, b) => {
        if (a.retryAt === undefined) return b.retryAt === undefined ? a.id.localeCompare(b.id) : -1;
        if (b.retryAt === undefined) return 1;
        return a.retryAt.localeCompare(b.retryAt) || a.id.localeCompare(b.id);
      });
    const checked = new Set<string>();
    for (const candidate of candidates) {
      const ref = candidate.conversationRef;
      const id = key(ref);
      if (checked.has(id)) continue;
      checked.add(id);
      const due = await Promise.all([
        options.episodic.store.peekDueJob(now, ref),
        options.semantic.store.peekDueJob(now, ref),
      ]);
      // A delayed or attention-blocked companion is still part of this snapshot. Wait for it
      // rather than admitting a singleton Mission, and keep looking for unrelated ready work.
      if (due.every((job) => job === undefined)) continue;
      if (due.some((job, index) => job === undefined && peers[index]!.has(id))) continue;
      return ref;
    }
    return undefined;
  };
  return {
    setExtractor(value: ConversationMemoryExtractor | undefined) {
      extractor = value;
    },
    get enabled() {
      return extractor !== undefined;
    },
    async runOnce(): Promise<void> {
      if (running !== undefined) return await running;
      const current = extractor;
      if (current === undefined) return;
      running = withFileLock(
        join(new PragmaPaths(options).memoryStateRoot(), "conversation-extraction.lock"),
        async () => {
          const now = options.now?.() ?? new Date();
          const conversationRef = await nextConversation(now);
          if (conversationRef === undefined) return;
          const episodic = await options.episodic.prepareBackgroundOnce(conversationRef);
          let semantic: ConversationExtractionBatch["semantic"];
          try {
            semantic = await options.semantic.prepareBackgroundOnce(conversationRef);
            if (episodic === undefined || semantic === undefined) {
              const jobs = await Promise.all([
                options.episodic.store.listExtractionJobs(),
                options.semantic.store.listExtractionJobs(),
              ]);
              if (
                [episodic, semantic].some(
                  (work, index) =>
                    work === undefined &&
                    jobs[index]!.some(
                      (job) =>
                        job.conversationRef.type === conversationRef.type &&
                        job.conversationRef.id === conversationRef.id &&
                        job.status !== "completed" &&
                        job.status !== "expired",
                    ),
                )
              ) {
                await Promise.all([episodic?.defer(), semantic?.defer()]);
                return;
              }
            }
            if (
              episodic !== undefined &&
              semantic !== undefined &&
              episodic.options?.watermark !== semantic.options?.watermark
            )
              throw new Error("memory_curator_snapshot_scope_changed");
            if (episodic === undefined && semantic === undefined) return;
            await current.extract({ episodic, semantic });
          } catch (error) {
            // Model admission/retry belongs exclusively to the shared Session. Never replay a delivery.
            const failure = Object.assign(
              new Error(error instanceof Error ? error.message : String(error), { cause: error }),
              { retryable: (error as { preAdmission?: boolean } | null)?.preAdmission === true },
            );
            await Promise.all([episodic?.fail(failure), semantic?.fail(failure)]);
          }
        },
      );
      try {
        await running;
      } finally {
        running = undefined;
      }
    },
  };
}
