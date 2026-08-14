import {
  DEFAULT_MEMORY_STORAGE_POLICY,
  EpisodicExtractionOutputSchema,
  KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION,
  MEMORY_CURATOR_PROMPT_VERSION,
  MEMORY_CURATOR_REF,
  SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
  SKILL_MEMORY_CURATOR_PROMPT_VERSION,
  SemanticExtractionOutputSchema,
  mergeMemoryEvidenceOmissionStats,
  selectBoundedMemoryEvidence,
  type EpisodicMemoryExtractor,
  type KnowledgeMemoryExtractor,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
  type SemanticMemoryExtractor,
  type SkillMemoryExtractor,
} from "@pragma/memory";
import {
  KnowledgeExtractionOutputSchema,
  SkillExtractionOutputSchema,
  type AgentMessageUsage,
  type MemoryEvidenceEnvelope,
  type MemoryExtractionOutputDiagnostic,
  type SkillExtractionInput,
  type SkillExtractionOutput,
} from "@pragma/shared";

import { inspectStructuredJson } from "./structured-output.ts";
import { z, type ZodType } from "zod";

export interface MemoryCuratorExecutionPort {
  run(input: {
    readonly jobId: string;
    readonly module: "episodic" | "semantic" | "knowledge" | "skill";
    readonly title: string;
    readonly prompt: string;
    readonly profile: MemoryExtractorProfile;
    readonly skillInput?: SkillExtractionInput | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    readonly content: string;
    readonly runtimeId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly responseModel?: string | undefined;
    readonly finishReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined;
    readonly usage?: AgentMessageUsage | undefined;
    readonly skillOutput?: SkillExtractionOutput | undefined;
  }>;
}

const SkillExtractionRejectionSchema = z
  .object({
    retain: z.literal(false),
    reason: z.enum([
      "no-reusable-skill",
      "insufficient-independent-sources",
      "fragmentary-pattern",
      "sensitive",
    ]),
  })
  .strict();

export interface BuiltInMemoryCurator {
  readonly episodicExtractor: EpisodicMemoryExtractor;
  readonly semanticExtractor: SemanticMemoryExtractor;
  readonly knowledgeExtractor: KnowledgeMemoryExtractor;
  readonly skillExtractor: SkillMemoryExtractor;
}

export function createBuiltInMemoryCurator(options: {
  readonly profiles: MemoryExtractorProfileStore;
  readonly execution: MemoryCuratorExecutionPort;
  readonly now?: (() => Date) | undefined;
}): BuiltInMemoryCurator {
  const now = options.now ?? (() => new Date());
  const provenance = (
    profile: MemoryExtractorProfile,
    execution: Awaited<ReturnType<MemoryCuratorExecutionPort["run"]>>,
    promptVersion: string,
  ) => ({
    curatorRef: MEMORY_CURATOR_REF,
    promptVersion,
    profileRevision: profile.revision,
    runtimeId: execution.runtimeId,
    providerId: execution.providerId,
    modelId: execution.modelId,
    ...(execution.responseModel === undefined ? {} : { responseModel: execution.responseModel }),
    extractedAt: now().toISOString(),
  });
  return {
    episodicExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const execution = await options.execution.run({
          jobId: input.jobId,
          module: "episodic",
          title: `Memory extraction ${input.executionId.slice(0, 12)}`,
          prompt: renderEpisodicExtractionPrompt(input),
          profile,
          signal: extractionOptions?.signal,
        });
        return {
          output: parseCuratorOutput(
            execution,
            EpisodicExtractionOutputSchema,
            "episodic_extraction_output_invalid",
          ),
          provenance: provenance(profile, execution, MEMORY_CURATOR_PROMPT_VERSION),
        };
      },
    },
    semanticExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const execution = await options.execution.run({
          jobId: input.jobId,
          module: "semantic",
          title: `Semantic extraction ${input.executionId.slice(0, 12)}`,
          prompt: renderSemanticExtractionPrompt(input),
          profile,
          signal: extractionOptions?.signal,
        });
        return {
          output: parseCuratorOutput(
            execution,
            SemanticExtractionOutputSchema,
            "semantic_extraction_output_invalid",
          ),
          provenance: provenance(profile, execution, SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION),
        };
      },
    },
    knowledgeExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const execution = await options.execution.run({
          jobId: input.jobId,
          module: "knowledge",
          title: `Knowledge extraction ${input.rootRef.id.slice(0, 12)}`,
          prompt: renderKnowledgeExtractionPrompt(input),
          profile,
          signal: extractionOptions?.signal,
        });
        return {
          output: parseCuratorOutput(
            execution,
            KnowledgeExtractionOutputSchema,
            "knowledge_extraction_output_invalid",
          ),
          provenance: provenance(profile, execution, KNOWLEDGE_MEMORY_CURATOR_PROMPT_VERSION),
        };
      },
    },
    skillExtractor: {
      async extract(input, extractionOptions) {
        const profile = await options.profiles.get();
        const execution = await options.execution.run({
          jobId: input.jobId,
          module: "skill",
          title: `Skill extraction ${input.rootRef.id.slice(0, 12)}`,
          prompt: renderSkillExtractionPrompt(input),
          profile,
          skillInput: input,
          signal: extractionOptions?.signal,
        });
        return {
          output:
            execution.skillOutput === undefined
              ? parseCuratorOutput(
                  execution,
                  SkillExtractionRejectionSchema,
                  "skill_extraction_output_invalid",
                )
              : SkillExtractionOutputSchema.parse(execution.skillOutput),
          provenance: provenance(profile, execution, SKILL_MEMORY_CURATOR_PROMPT_VERSION),
        };
      },
    },
  };
}

function parseCuratorOutput<T>(
  execution: Awaited<ReturnType<MemoryCuratorExecutionPort["run"]>>,
  schema: ZodType<T>,
  code: string,
): T {
  const inspection = inspectStructuredJson(execution.content);
  const diagnostic = curatorOutputDiagnostic(execution, inspection.closingBoundaryFound);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspection.content);
  } catch (cause) {
    throw Object.assign(new Error(code, { cause }), {
      code,
      retryable: true,
      runtimeId: execution.runtimeId,
      providerId: execution.providerId,
      modelId: execution.modelId,
      outputDiagnostic: {
        ...diagnostic,
        ...(parsePosition(cause) === undefined ? {} : { parsePosition: parsePosition(cause) }),
      },
    });
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      Object.assign(error, {
        code,
        retryable: true,
        runtimeId: execution.runtimeId,
        providerId: execution.providerId,
        modelId: execution.modelId,
        outputDiagnostic: diagnostic,
      });
    }
    throw error;
  }
}

export function renderEpisodicExtractionPrompt(
  input: Parameters<EpisodicMemoryExtractor["extract"]>[0],
): string {
  return renderBoundedPrompt(input.evidence, input.omittedEvidence, (projection, omissions) =>
    [
      "Extract an Episodic Memory from this safe Evidence projection.",
      "Return retain=false for low-value or insufficient evidence.",
      "Each Evidence id is the exact messageId to cite in evidenceRefs. Use no identifiers other than those ids.",
      "Steward provenance identifies the responsible root agent/team and producing agents; it is context, not evidence content.",
      "Output schema:",
      '{"retain":true,"language":"zh-Hans","goal":{"text":"...","evidenceRefs":["..."]},"summary":{"text":"...","evidenceRefs":["..."]},"attempts":[{"description":"...","result":"...","evidenceRefs":["..."]}],"failuresAndRecoveries":[{"failure":"...","recovery":"...","evidenceRefs":["..."]}],"outcome":{"status":"succeeded|failed|cancelled|interrupted","summary":"...","evidenceRefs":["..."]},"valueScore":0.0}',
      'or {"retain":false,"reason":"low-value|insufficient-evidence|sensitive"}.',
      "Steward directory (Evidence.steward is a zero-based index):",
      JSON.stringify(projection.stewards),
      "Evidence (chronological, compact):",
      JSON.stringify(projection.evidence),
      "Omitted Evidence statistics (no omitted content):",
      JSON.stringify(omissions),
    ].join("\n\n"),
  );
}

export function renderSemanticExtractionPrompt(
  input: Parameters<SemanticMemoryExtractor["extract"]>[0],
): string {
  return renderBoundedPrompt(input.evidence, input.omittedEvidence, (projection, omissions) =>
    [
      "Extract current Semantic/Fact Memory from this safe Evidence projection.",
      "Return retain=false when there is no stable, reusable fact. Do not turn historical outcomes into current truth.",
      "Use only exact entries from allowedSubjectRefs and Evidence ids. Never invent a subject id or Evidence id.",
      "Use a namespaced predicate. normalizedValue must be a concise canonical value for deduplication.",
      "Use conflictMode=exclusive only when the subject can have one current value for that predicate; otherwise use compatible.",
      "When a direct user message unambiguously changes an existing exclusive fact, set replacementTarget to that current fact id and revision. Never replace a fact based only on assistant, tool, or summary text.",
      "Confidence must be between 0 and 0.95. Only include reviewAt or expiresAt when Evidence explicitly supports that time.",
      "Steward provenance identifies the responsible root agent/team and producing agents; it is context, not evidence content.",
      "Output schema:",
      '{"retain":true,"facts":[{"statement":"...","subjectRefs":[{"type":"pragma.user","id":"..."}],"predicate":"user.preference.language","normalizedValue":"zh-Hans","conflictMode":"exclusive|compatible","confidence":0.0,"evidenceRefs":["..."],"replacementTarget":{"factId":"optional current fact id","expectedRevision":1},"reviewAt":"optional ISO time","expiresAt":"optional ISO time"}]}',
      'or {"retain":false,"reason":"no-stable-fact|insufficient-evidence|sensitive"}.',
      "Allowed subjects:",
      JSON.stringify(input.allowedSubjectRefs),
      "Current exclusive facts eligible for an explicit replacement:",
      JSON.stringify(input.currentFacts),
      "Steward directory (Evidence.steward is a zero-based index):",
      JSON.stringify(projection.stewards),
      "Evidence (chronological, compact):",
      JSON.stringify(projection.evidence),
      "Omitted Evidence statistics (no omitted content):",
      JSON.stringify(omissions),
    ].join("\n\n"),
  );
}

export function renderKnowledgeExtractionPrompt(
  input: Parameters<KnowledgeMemoryExtractor["extract"]>[0],
): string {
  return enforcePromptLimit(
    [
      "Extract reusable Knowledge candidates from these already-curated Memory source revisions.",
      "Candidates are proposals for human review, not automatically published instructions.",
      "Each candidate must cite exact supplied sourceRefs and at least one Semantic source. It is eligible only when one cited Semantic source is verified or the cited Semantic sources collectively cover at least two distinct sourceExecutionIds.",
      "Episodic sources are supplemental only. Use them to enrich steps, failures, and recoveries, never as independent authority or current truth.",
      "normalizedKey must be a stable lowercase root-scoped deduplication key using only letters, numbers, dot, underscore, colon, slash, or hyphen.",
      "Keep guidance concrete and reusable. Do not invent facts, identifiers, permissions, or provenance.",
      "Output schema:",
      '{"retain":true,"candidates":[{"content":{"title":"...","summary":"...","guidance":["..."],"normalizedKey":"workflow.example"},"sourceRefs":[{"kind":"episodic|semantic","id":"...","revision":1}]}]}',
      'or {"retain":false,"reason":"no-reusable-knowledge|insufficient-sources|sensitive"}.',
      "Root:",
      JSON.stringify(input.rootRef),
      "Sources:",
      JSON.stringify(input.sources),
    ].join("\n\n"),
  );
}

export function renderSkillExtractionPrompt(
  input: Parameters<SkillMemoryExtractor["extract"]>[0],
): string {
  return enforcePromptLimit(
    [
      "Extract at most three complete, reusable Skill candidates from these curated Memory sources.",
      "A Skill is a coherent executable workflow, not a fact, isolated tip, command fragment, or one-off success. Merge related steps into one Skill and return retain=false when the pattern is fragmentary.",
      "Every candidate must cite at least three distinct high-value Episodic ids across at least two conversations; at least two must have succeeded or recovered successfully. Semantic sources may support but never satisfy this threshold.",
      "Generate SKILL.md plus optional references/*.md. Scripts are optional and must be dependency-free Node 22 ESM under scripts/*.mjs with node:test coverage under tests/*.test.mjs.",
      "For each candidate create at least three source replay expectations and one clearly non-applicable boundary case.",
      'Compare only existingTargets. Use revise only for one clear match, ambiguous for two or more plausible matches, otherwise create. Never invent a binding id. route is always an object: use {"type":"create"}; use {"type":"revise","bindingId":"an existing binding UUID"}; or use {"type":"ambiguous","bindingIds":["existing binding UUID 1","existing binding UUID 2"]}.',
      "For every candidate, call begin_skill_draft with metadata, sourceRefs, and route; call put_skill_file once per file; then call submit_skill_draft. Repair validation errors in the same draft and resubmit. Never place Skill file contents in the final response.",
      "After at least one draft is submitted successfully, finish with a brief acknowledgement. The Host uses the submitted drafts as the result.",
      'If no reusable Skill exists, do not create a draft; return exactly {"retain":false,"reason":"no-reusable-skill|insufficient-independent-sources|fragmentary-pattern|sensitive"}.',
      "Root:",
      JSON.stringify(input.rootRef),
      "Existing Memory Skills:",
      JSON.stringify(input.existingTargets),
      "Sources:",
      JSON.stringify(input.sources),
    ].join("\n\n"),
  );
}

function curatorOutputDiagnostic(
  execution: Awaited<ReturnType<MemoryCuratorExecutionPort["run"]>>,
  closingBoundaryFound: boolean,
): MemoryExtractionOutputDiagnostic {
  return {
    responseBytes: Buffer.byteLength(execution.content),
    responseCharacters: [...execution.content].length,
    closingBoundaryFound,
    ...(execution.finishReason === undefined ? {} : { finishReason: execution.finishReason }),
    ...(execution.finishReason === undefined
      ? {}
      : { truncated: execution.finishReason === "length" }),
    ...(execution.usage === undefined
      ? {}
      : {
          usage: {
            measurement: execution.usage.measurement,
            inputTokens: execution.usage.input,
            outputTokens: execution.usage.output,
            totalTokens: execution.usage.totalTokens,
          },
        }),
  };
}

function parsePosition(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /(?:position|at position)\s+(\d+)/iu.exec(error.message);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function renderBoundedPrompt(
  evidence: readonly MemoryEvidenceEnvelope[],
  persistentOmissions: Parameters<EpisodicMemoryExtractor["extract"]>[0]["omittedEvidence"],
  render: (
    projection: CompactMemoryEvidenceProjection,
    omissions: Parameters<EpisodicMemoryExtractor["extract"]>[0]["omittedEvidence"],
  ) => string,
): string {
  let evidenceBudget = DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes;
  for (;;) {
    const selected = selectBoundedMemoryEvidence(
      evidence,
      {
        maxRecords: DEFAULT_MEMORY_STORAGE_POLICY.evidenceMaxRecordsPerExecution,
        maxBytes: evidenceBudget,
      },
      estimateCompactMemoryEvidenceBytes,
    );
    const projection = compactMemoryEvidence(selected.retained);
    const prompt = render(
      projection,
      mergeMemoryEvidenceOmissionStats(persistentOmissions, selected.omittedStats),
    );
    const overflow =
      Buffer.byteLength(prompt) - DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes;
    if (overflow <= 0) return prompt;
    if (evidenceBudget === 0) throw new Error("memory_curator_prompt_metadata_too_large");
    evidenceBudget = Math.max(0, evidenceBudget - overflow - 512);
  }
}

interface CompactMemoryEvidenceProjection {
  readonly stewards: readonly CompactMemorySteward[];
  readonly evidence: readonly CompactMemoryEvidence[];
}

interface CompactMemorySteward {
  readonly root: string;
  readonly producers: readonly string[];
}

interface CompactMemoryEvidence {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly steward?: number | undefined;
  readonly text?: string | undefined;
  readonly tool?: string | undefined;
  readonly phase?: string | undefined;
  readonly status?: string | undefined;
  readonly outcome?: string | undefined;
  readonly artifact?:
    | {
        readonly kind: string;
        readonly title?: string | undefined;
        readonly uri?: string | undefined;
      }
    | undefined;
}

function compactMemoryEvidence(
  evidence: readonly MemoryEvidenceEnvelope[],
): CompactMemoryEvidenceProjection {
  const stewards: CompactMemorySteward[] = [];
  const stewardIndexes = new Map<string, number>();
  const compact = evidence.map((item) => {
    const steward = compactMemorySteward(item);
    const stewardKey = steward === undefined ? undefined : JSON.stringify(steward);
    let stewardIndex: number | undefined;
    if (stewardKey !== undefined) {
      stewardIndex = stewardIndexes.get(stewardKey);
      if (stewardIndex === undefined) {
        stewardIndex = stewards.length;
        stewardIndexes.set(stewardKey, stewardIndex);
        stewards.push(steward!);
      }
    }
    return compactMemoryEvidenceRecord(item, stewardIndex);
  });
  return { stewards, evidence: compact };
}

function compactMemorySteward(item: MemoryEvidenceEnvelope): CompactMemorySteward | undefined {
  if (item.attribution === undefined) return undefined;
  return {
    root: compactRef(item.attribution.rootRef),
    producers: item.attribution.producerRefs.map(compactRef),
  };
}

function compactMemoryEvidenceRecord(
  item: MemoryEvidenceEnvelope,
  steward: number | undefined,
): CompactMemoryEvidence {
  const base = {
    id: item.messageId,
    at: item.occurredAt,
    ...(steward === undefined ? {} : { steward }),
  };
  const payload = record(item.payload);
  const message = record(payload?.["message"]);
  if (message !== undefined && typeof message["role"] === "string") {
    return {
      ...base,
      kind: message["role"],
      ...(typeof message["text"] === "string" ? { text: message["text"] } : {}),
      ...(typeof message["toolName"] === "string" ? { tool: message["toolName"] } : {}),
      ...(typeof message["status"] === "string" ? { status: message["status"] } : {}),
      ...(message["stopReason"] !== "stop" && typeof message["stopReason"] === "string"
        ? { status: message["stopReason"] }
        : {}),
    };
  }
  if (typeof payload?.["toolName"] === "string" && typeof payload["phase"] === "string") {
    return {
      ...base,
      kind: "tool",
      tool: payload["toolName"],
      phase: payload["phase"],
    };
  }
  if (typeof payload?.["outcome"] === "string") {
    return { ...base, kind: "terminal", outcome: payload["outcome"] };
  }
  if (item.topic === "artifact.created" && typeof payload?.["kind"] === "string") {
    return {
      ...base,
      kind: "artifact",
      artifact: {
        kind: payload["kind"],
        ...(typeof payload["title"] === "string" ? { title: payload["title"] } : {}),
        ...(typeof payload["uri"] === "string" ? { uri: payload["uri"] } : {}),
      },
    };
  }
  return { ...base, kind: item.topic };
}

function estimateCompactMemoryEvidenceBytes(item: MemoryEvidenceEnvelope): number {
  return Buffer.byteLength(JSON.stringify(compactMemoryEvidence([item])));
}

function compactRef(ref: { readonly type: string; readonly id: string }): string {
  return `${ref.type}:${ref.id}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function enforcePromptLimit(prompt: string): string {
  if (Buffer.byteLength(prompt) > DEFAULT_MEMORY_STORAGE_POLICY.extractionPromptMaxBytes) {
    throw new Error("memory_curator_prompt_metadata_too_large");
  }
  return prompt;
}
