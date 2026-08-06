import {
  SkillExtractionInputSchema,
  SkillExtractionOutputSchema,
  SkillExtractorProvenanceSchema,
  type SkillExtractionInput,
  type SkillExtractionOutput,
  type SkillExtractorProvenance,
} from "@pragma/shared";

export const SKILL_MEMORY_CURATOR_PROMPT_VERSION = "skill-curator/v1" as const;

export * from "@pragma/shared";

export interface SkillMemoryExtractor {
  extract(
    input: SkillExtractionInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly output: SkillExtractionOutput; readonly provenance: SkillExtractorProvenance }>;
}

export function parseSkillExtractionResult(input: {
  readonly input: unknown;
  readonly output: unknown;
  readonly provenance: unknown;
}) {
  return {
    input: SkillExtractionInputSchema.parse(input.input),
    output: SkillExtractionOutputSchema.parse(input.output),
    provenance: SkillExtractorProvenanceSchema.parse(input.provenance),
  };
}
