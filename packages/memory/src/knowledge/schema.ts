import {
  KnowledgeExtractionInputSchema,
  KnowledgeExtractionOutputSchema,
  KnowledgeExtractorProvenanceSchema,
  KnowledgeSourceSnapshotSchema,
  type KnowledgeExtractionInput,
  type KnowledgeExtractionOutput,
  type KnowledgeExtractorProvenance,
  type KnowledgeSourceSnapshot,
} from "@pragma/shared";

export const KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION = "knowledge-curator/v1" as const;

export {
  KnowledgeContentSchema,
  KnowledgeExtractionCandidateSchema,
  KnowledgeExtractionInputSchema,
  KnowledgeExtractionJobSchema,
  KnowledgeExtractionOutputSchema,
  KnowledgeExtractorProvenanceSchema,
  KnowledgeSourceRevisionRefSchema,
  KnowledgeSourceSnapshotSchema,
} from "@pragma/shared";

export type {
  KnowledgeContent,
  KnowledgeExtractionCandidate,
  KnowledgeExtractionInput,
  KnowledgeExtractionJob,
  KnowledgeExtractionOutput,
  KnowledgeExtractorProvenance,
  KnowledgeSourceRevisionRef,
  KnowledgeSourceSnapshot,
} from "@pragma/shared";

export interface KnowledgeMemoryExtractor {
  extract(
    input: KnowledgeExtractionInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{
    readonly output: KnowledgeExtractionOutput;
    readonly provenance: KnowledgeExtractorProvenance;
  }>;
}

/** Read-only boundary used by Knowledge; source Modules remain the sole owners of their stores. */
export interface KnowledgeSourceReader {
  listEligibleSources(input: {
    readonly rootRef: KnowledgeSourceSnapshot["rootRef"];
    readonly executionId?: string | undefined;
    readonly limit: number;
    readonly now: Date;
  }): Promise<readonly KnowledgeSourceSnapshot[]>;
}

export function parseKnowledgeExtractionResult(input: {
  readonly input: unknown;
  readonly output: unknown;
  readonly provenance: unknown;
}) {
  return {
    input: KnowledgeExtractionInputSchema.parse(input.input),
    output: KnowledgeExtractionOutputSchema.parse(input.output),
    provenance: KnowledgeExtractorProvenanceSchema.parse(input.provenance),
  };
}

export function parseKnowledgeSourceSnapshot(input: unknown): KnowledgeSourceSnapshot {
  return KnowledgeSourceSnapshotSchema.parse(input);
}
