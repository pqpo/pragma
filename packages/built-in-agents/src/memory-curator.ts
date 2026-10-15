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
} from "@pragma/memory";

export interface MemoryCuratorExecutionPort {
  run(input: {
    readonly jobId: string;
    readonly module: "episodic" | "semantic";
    readonly title: string;
    readonly prompt: string;
    readonly session: MemoryExtractionSession;
    readonly profile: MemoryExtractorProfile;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void>;
}
export interface BuiltInMemoryCurator {
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
