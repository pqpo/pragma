import {
  createMemoryExtractionSessionStore,
  EpisodicExtractionOutputSchema,
  MEMORY_CURATOR_PROMPT_VERSION,
  SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
  type EpisodicMemoryExtractor,
  type MemoryExtractionSession,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
  type SemanticMemoryExtractor,
  ConversationExtractionInputSchema,
  type ConversationMemoryExtractor,
  type MemoryExtractionType,
  conversationExtractionJobId,
} from "@pragma/memory";
import { createHash } from "node:crypto";

export interface MemoryCuratorExecutionPort {
  run(input: {
    readonly resumeObservation?: boolean | undefined;
    readonly jobId: string;
    readonly module: "episodic" | "semantic" | "conversation";
    readonly title: string;
    readonly prompt: string;
    readonly session: MemoryExtractionSession;
    readonly profile: MemoryExtractorProfile;
    readonly signal?: AbortSignal | undefined;
    readonly onAdmission?: (() => void) | undefined;
  }): Promise<void>;
}
export interface BuiltInMemoryCurator {
  readonly conversationExtractor: ConversationMemoryExtractor;
  readonly episodicExtractor: EpisodicMemoryExtractor;
  readonly semanticExtractor: SemanticMemoryExtractor;
}
export function createBuiltInMemoryCurator(options: {
  readonly profiles: MemoryExtractorProfileStore;
  readonly execution: MemoryCuratorExecutionPort;
  readonly pragmaHome: string;
  readonly now?: (() => Date) | undefined;
}): BuiltInMemoryCurator {
  const sessions = createMemoryExtractionSessionStore(options);
  return {
    conversationExtractor: {
      async extract(batch) {
        const entries = (["episodic", "semantic"] as const).flatMap((type) =>
          batch[type] === undefined ? [] : [{ type, work: batch[type]! }],
        );
        if (entries.length === 0) return;
        const first = entries[0]!.work;
        const evidence = new Map<string, (typeof first.input.evidence)[number]>();
        const evidenceTypes: Record<string, MemoryExtractionType[]> = {};
        for (const { type, work } of entries) {
          for (const item of work.input.evidence) {
            const previous = evidence.get(item.messageId);
            if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(item))
              throw new Error("memory_curator_snapshot_scope_changed");
            evidence.set(item.messageId, item);
            (evidenceTypes[item.messageId] ??= []).push(type);
          }
        }
        const jobs = Object.fromEntries(
          entries.map(({ type, work }) => [
            type,
            {
              jobId: work.input.jobId,
              watermark: work.options?.watermark ?? work.input.executionId,
            },
          ]),
        );
        const jobId = conversationExtractionJobId(
          first.options?.conversationRef ?? {
            type: "pragma.execution",
            id: first.input.executionId,
          },
          first.options?.watermark ?? first.input.executionId,
        );
        const watermark = createHash("sha256").update(JSON.stringify(jobs)).digest("hex");
        const semantic = batch.semantic;
        const input = ConversationExtractionInputSchema.parse({
          schemaVersion: "pragma.memory-conversation-extraction-input/v1",
          jobId,
          executionId: first.input.executionId,
          targets: entries.map(({ type }) => type),
          jobs,
          evidenceTypes,
          evidence: [...evidence.values()],
          omittedEvidence: first.input.omittedEvidence,
          omittedByType: Object.fromEntries(
            entries.map(({ type, work }) => [type, work.input.omittedEvidence]),
          ),
          allowedSubjectRefs:
            semantic?.input.allowedSubjectRefs ??
            first.options?.memory?.subjects ??
            first.input.evidence.flatMap((item) => item.subjectRefs),
          currentFacts: semantic?.input.currentFacts ?? [],
          previousEpisode: batch.episodic?.input.previousEpisode,
        });
        const signal = AbortSignal.any(
          entries.flatMap(({ work }) =>
            work.options?.signal === undefined ? [] : [work.options.signal],
          ),
        );
        const accesses = entries.flatMap(({ work }) =>
          work.options?.memory === undefined ? [] : [work.options.memory],
        );
        const primary = accesses[0];
        const memory =
          primary === undefined || accesses.length !== entries.length
            ? undefined
            : primary.intersect(accesses.slice(1));
        const session = await sessions.create({
          module: "conversation",
          activeTypes: entries.map(({ type }) => type),
          input,
          watermark,
          signal,
          memory,
          findFacts: semantic?.options?.findFacts,
          canUseFact: semantic?.options?.canUseFact,
          async isCurrent() {
            for (const { work } of entries)
              if (
                !work.finished &&
                work.options?.isCurrent !== undefined &&
                !(await work.options.isCurrent())
              )
                return false;
            return true;
          },
          async assertAccess() {
            for (const { work } of entries) await work.options?.assertAccess?.();
          },
          async assertEvidenceAccess(evidence, type) {
            for (const { work } of entries)
              await work.options?.assertEvidenceAccess?.(evidence, type);
          },
          async onProvenance(type, previous, next) {
            await batch[type]?.options?.onProvenance?.(type, previous, next);
          },
          async onResult(type, receipt) {
            if (type === "episodic" && batch.episodic !== undefined)
              await batch.episodic.settle({
                ...receipt,
                output: EpisodicExtractionOutputSchema.parse(receipt.output),
              });
            if (type === "semantic" && batch.semantic !== undefined)
              await batch.semantic.settle({
                ...receipt,
                output: SemanticExtractionOutputSchema.parse(receipt.output),
              });
          },
        });
        const settleReceipts = async (): Promise<void> => {
          for (const { type, work } of entries) {
            if (work.finished) continue;
            const receipt = await session.receiptFor(type);
            if (receipt === undefined) continue;
            if (type === "episodic")
              await batch.episodic!.settle({
                ...receipt,
                output: EpisodicExtractionOutputSchema.parse(receipt.output),
              });
            else
              await batch.semantic!.settle({
                ...receipt,
                output: SemanticExtractionOutputSchema.parse(receipt.output),
              });
          }
        };
        // Recovery and materialization never admit a model.
        await settleReceipts();
        try {
          if (!(await session.completed())) {
            await options.execution.run({
              jobId,
              resumeObservation: entries.some(({ work }) => work.options?.resumeObservation),
              module: "conversation",
              title: `Memory extraction ${first.input.executionId.slice(0, 12)}`,
              prompt: session.prompt(),
              session,
              profile: await options.profiles.get(),
              signal,
              onAdmission() {
                for (const { work } of entries) if (!work.finished) work.options?.onAdmission?.();
              },
            });
          }
          if (!(await session.completed()))
            throw Object.assign(new Error("memory_curator_result_unavailable"), {
              retryable: false,
            });
        } finally {
          // A missed/failed tool notification cannot strand a Module claim after a durable finish.
          await settleReceipts();
        }
      },
    },
    episodicExtractor: {
      async recover(jobId, watermark, input) {
        const result = await sessions.recover("episodic", jobId, watermark, input);
        return result === undefined
          ? undefined
          : { ...result, output: EpisodicExtractionOutputSchema.parse(result.output) };
      },
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const session = await sessions.create({
          ...extractionOptions,
          module: "episodic",
          input,
          watermark: extractionOptions?.watermark ?? input.executionId,
        });
        if ((await session.receipt()) === undefined)
          await options.execution.run({
            jobId: input.jobId,
            module: "episodic",
            title: `Memory extraction ${input.executionId.slice(0, 12)}`,
            prompt: session.prompt(),
            session,
            profile,
            signal: extractionOptions?.signal,
          });
        const receipt = await session.receipt();
        if (receipt === undefined)
          throw Object.assign(new Error("memory_curator_result_unavailable"), { retryable: false });
        return { ...receipt, output: EpisodicExtractionOutputSchema.parse(receipt.output) };
      },
    },
    semanticExtractor: {
      async recover(jobId, watermark, input) {
        const result = await sessions.recover("semantic", jobId, watermark, input);
        return result === undefined
          ? undefined
          : { ...result, output: SemanticExtractionOutputSchema.parse(result.output) };
      },
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const session = await sessions.create({
          ...extractionOptions,
          module: "semantic",
          input,
          watermark: extractionOptions?.watermark ?? input.executionId,
        });
        if ((await session.receipt()) === undefined)
          await options.execution.run({
            jobId: input.jobId,
            module: "semantic",
            title: `Semantic extraction ${input.executionId.slice(0, 12)}`,
            prompt: session.prompt(),
            session,
            profile,
            signal: extractionOptions?.signal,
          });
        const receipt = await session.receipt();
        if (receipt === undefined)
          throw Object.assign(new Error("memory_curator_result_unavailable"), { retryable: false });
        return { ...receipt, output: SemanticExtractionOutputSchema.parse(receipt.output) };
      },
    },
  };
}
import { SemanticExtractionOutputSchema } from "@pragma/memory";
export { MEMORY_CURATOR_PROMPT_VERSION, SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION };
