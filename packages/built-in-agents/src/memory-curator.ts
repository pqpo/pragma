import {
  DEFAULT_MEMORY_STORAGE_POLICY,
  EpisodicExtractionOutputSchema,
  MEMORY_CURATOR_PROMPT_VERSION,
  MEMORY_CURATOR_REF,
  SEMANTIC_MEMORY_CURATOR_PROMPT_VERSION,
  SemanticExtractionOutputSchema,
  mergeMemoryEvidenceOmissionStats,
  selectBoundedMemoryEvidence,
  type EpisodicMemoryExtractor,
  type MemoryExtractorProfile,
  type MemoryExtractorProfileStore,
  type SemanticMemoryExtractor,
} from "@pragma/memory";
import {
  type AgentMessageUsage,
  type MemoryEvidenceEnvelope,
  type MemoryExtractionOutputDiagnostic,
} from "@pragma/shared";

import { inspectStructuredJson } from "./structured-output.ts";
import { type ZodType } from "zod";

export interface MemoryCuratorExecutionPort {
  run(input: {
    readonly jobId: string;
    readonly module: "episodic" | "semantic";
    readonly title: string;
    readonly prompt: string;
    readonly profile: MemoryExtractorProfile;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{
    readonly content: string;
    readonly runtimeId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly responseModel?: string | undefined;
    readonly finishReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined;
    readonly usage?: AgentMessageUsage | undefined;
  }>;
}

export interface BuiltInMemoryCurator {
  readonly episodicExtractor: EpisodicMemoryExtractor;
  readonly semanticExtractor: SemanticMemoryExtractor;
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
