import type { MemoryEvidenceEnvelope, MemorySubjectRef } from "@pragma/shared";

import { createEpisodicMemoryContextProvider } from "./context.ts";
import {
  EpisodicExtractionInputSchema,
  EpisodicExtractionOutputSchema,
  EpisodicMemoryRecordSchema,
  type EpisodicMemoryExtractor,
} from "./schema.ts";
import { createEpisodicMemoryStore, episodicMemoryId, type EpisodicMemoryStore } from "./store.ts";
import { extractionErrorCode } from "../pipeline/extraction-error-code.ts";
import type { MemoryModule } from "../pipeline/memory-module.ts";

export interface EpisodicMemoryModule extends MemoryModule {
  setExtractor(extractor: EpisodicMemoryExtractor | undefined): Promise<void>;
  readonly store: EpisodicMemoryStore;
  close(): void;
}

export async function createEpisodicMemoryModule(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly extractor?: EpisodicMemoryExtractor | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): Promise<EpisodicMemoryModule> {
  const store = await createEpisodicMemoryStore(options);
  const now = options.now ?? (() => new Date());
  let extractor = options.extractor;

  return {
    descriptor: {
      id: "pragma.memory.episodic",
      version: "1.0.0",
      pathPrefix: "episodic",
      storageModel: "dynamic-projection",
      purpose: "projection",
      contextLayers: {
        usagePrompt:
          "Use Episodic Memory for historical precedent in the current asset plus the current Expert's personal history. Keep those ownership scopes distinct: Team or Flow experience is not the producer Expert's personal history. It is not current truth.",
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
        topic: "execution.message.appended",
        schemaRefs: ["pragma.memory.execution-message/v2"],
      },
      {
        topic: "execution.invocation.terminal",
        schemaRefs: ["pragma.memory.invocation-terminal/v2"],
      },
      {
        topic: "execution.execution.terminal",
        schemaRefs: ["pragma.memory.execution-terminal/v2"],
      },
      ...(["started", "completed", "failed"] as const).map((phase) => ({
        topic: `execution.tool.${phase}`,
        schemaRefs: ["pragma.memory.tool-event/v2"],
      })),
      { topic: "artifact.created", schemaRefs: ["pragma.memory.artifact-event/v1"] },
      {
        topic: "artifact.handoff.registered",
        schemaRefs: ["pragma.memory.handoff-artifact/v1"],
      },
    ],
    createContextProvider(scope) {
      return createEpisodicMemoryContextProvider(store, scope);
    },
    async consume(envelopes) {
      await store.ingest(envelopes);
      return {};
    },
    async runBackgroundOnce() {
      if (extractor === undefined) return;
      const job = await store.claimDueJob(now());
      if (job === undefined) return;
      const evidence = sanitizeEvidence(await store.readEvidence(job.executionId));
      try {
        if (evidence.some((item) => item.sensitivity === "restricted")) {
          await store.completeRejected(job, "sensitive", now());
          return;
        }
        if (isLowValue(evidence)) {
          await store.completeRejected(job, "low-value", now());
          return;
        }
        const visibility = strictestVisibility(evidence);
        if (visibility === undefined) {
          await store.completeRejected(job, "policy", now());
          return;
        }
        const previousEpisode = await store.getByExecution(job.executionId);
        if (previousEpisode?.terminalMessageId === job.terminalMessageId) {
          await store.completeRetained({ job, record: previousEpisode, evidence, now: now() });
          return;
        }
        const input = EpisodicExtractionInputSchema.parse({
          schemaVersion: "pragma.memory-episodic-extraction-input/v2",
          jobId: job.id,
          executionId: job.executionId,
          ...(previousEpisode === undefined ? {} : { previousEpisode }),
          evidence,
          omittedEvidence: await store.readOmissionStats(job.executionId),
        });
        const extracted = await extractor.extract(input);
        const output = EpisodicExtractionOutputSchema.parse(extracted.output);
        if (!output.retain) {
          await store.completeRejected(job, output.reason, now());
          return;
        }
        assertEvidenceRefs(output, new Set(evidence.map((item) => item.messageId)));
        const completedAt = now();
        const timestamp = completedAt.toISOString();
        const attribution = resolveAttribution(evidence);
        const record = EpisodicMemoryRecordSchema.parse({
          schemaVersion: "pragma.memory-episodic/v2",
          id: episodicMemoryId(job.executionId),
          revision: (previousEpisode?.revision ?? 0) + 1,
          executionId: job.executionId,
          terminalMessageId: job.terminalMessageId,
          rootRefs: [attribution.rootRef],
          producerRefs: attribution.producerRefs,
          language: output.language,
          goal: output.goal,
          summary: output.summary,
          attempts: output.attempts,
          failuresAndRecoveries: output.failuresAndRecoveries,
          outcome: output.outcome,
          artifactRefs: artifactRefs(evidence),
          evidenceRefs: collectEvidenceRefs(output),
          visibility,
          sensitivity: strictestSensitivity(evidence),
          bindings: [
            {
              consumerRef: attribution.rootRef,
              recall: "allow",
              export: "deny",
              permissionRevision: 1,
            },
          ],
          valueScore: output.valueScore,
          status: "active",
          extractor: extracted.provenance,
          createdAt: previousEpisode?.createdAt ?? timestamp,
          updatedAt: timestamp,
        });
        await store.completeRetained({ job, record, evidence, now: completedAt });
      } catch (error) {
        await store.fail({
          job,
          errorCode: extractionErrorCode(error, "episodic_extraction"),
          now: now(),
          retry: isConfigurationError(error) ? "configuration" : "transient",
        });
      }
    },
    async setExtractor(next) {
      extractor = next;
    },
    store,
    close() {
      store.close();
    },
  };
}

function isLowValue(evidence: readonly MemoryEvidenceEnvelope[]): boolean {
  const texts = evidence.flatMap((item) => {
    if (item.schemaRef !== "pragma.memory.execution-message/v2") return [];
    const payload = item.payload as {
      readonly message?: { readonly role?: string; readonly text?: string };
    };
    return typeof payload.message?.text === "string"
      ? [{ role: payload.message.role, text: payload.message.text.trim() }]
      : [];
  });
  const userLength = texts
    .filter((item) => item.role === "user")
    .reduce((total, item) => total + item.text.length, 0);
  const assistantLength = texts
    .filter((item) => item.role === "assistant")
    .reduce((total, item) => total + item.text.length, 0);
  const action = evidence.some(
    (item) => item.topic.startsWith("execution.tool.") || item.topic.startsWith("artifact."),
  );
  return !action && userLength < 20 && assistantLength < 120;
}

function sanitizeEvidence(
  evidence: readonly MemoryEvidenceEnvelope[],
): readonly MemoryEvidenceEnvelope[] {
  return evidence.map((item) => ({
    ...item,
    payload: redactValue(item.payload),
  }));
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
}

function redact(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[REDACTED_CREDENTIAL]")
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED_CREDENTIAL]",
    );
}

function assertEvidenceRefs(
  output: { readonly [key: string]: unknown },
  allowed: Set<string>,
): void {
  for (const ref of collectEvidenceRefs(output)) {
    if (!allowed.has(ref)) throw new Error(`extractor_evidence_ref_invalid:${ref}`);
  }
}

function collectEvidenceRefs(value: unknown): string[] {
  const refs = new Set<string>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== "object" || item === null) return;
    for (const [key, nested] of Object.entries(item)) {
      if (key === "evidenceRefs" && Array.isArray(nested)) {
        nested.forEach((ref) => {
          if (typeof ref === "string") refs.add(ref);
        });
      } else visit(nested);
    }
  };
  visit(value);
  return [...refs];
}

function resolveAttribution(evidence: readonly MemoryEvidenceEnvelope[]): {
  readonly rootRef: MemorySubjectRef;
  readonly producerRefs: readonly MemorySubjectRef[];
} {
  const resolvedRoots = evidence.map((item) => {
    if (item.attribution !== undefined) return item.attribution.rootRef;
    return legacyRootRef(item);
  });
  if (resolvedRoots.some((root) => root === undefined)) {
    throw new Error("episodic_root_attribution_invalid");
  }
  const roots = uniqueRefs(resolvedRoots as readonly MemorySubjectRef[]);
  if (roots.length !== 1 || !isExecutionRootRef(roots[0]!)) {
    throw new Error("episodic_root_attribution_invalid");
  }
  const rootRef = roots[0]!;
  const producerRefs = uniqueRefs(
    evidence.flatMap(
      (item) =>
        item.attribution?.producerRefs ??
        item.subjectRefs.filter((ref) => ref.type === "pragma.expert"),
    ),
  );
  return { rootRef, producerRefs };
}

function legacyRootRef(evidence: MemoryEvidenceEnvelope): MemorySubjectRef | undefined {
  const candidates = uniqueRefs(
    evidence.bindings
      .filter((binding) => binding.access === "allow" && isExecutionRootRef(binding.consumerRef))
      .map((binding) => binding.consumerRef),
  );
  const assetCandidates = candidates.filter((ref) => ref.type !== "pragma.expert");
  if (assetCandidates.length === 1) return assetCandidates[0];
  if (assetCandidates.length > 1) return undefined;
  // Pre-attribution Evidence emitted root Expert before producer Experts. That ordering is the
  // only role signal available when every candidate is an Expert.
  return candidates[0];
}

function artifactRefs(evidence: readonly MemoryEvidenceEnvelope[]): MemorySubjectRef[] {
  return uniqueRefs(
    evidence.flatMap((item) => {
      if (item.topic !== "artifact.created") return [];
      const payload = item.payload as { readonly artifactId?: unknown };
      return typeof payload.artifactId === "string"
        ? [{ type: "pragma.artifact", id: payload.artifactId }]
        : [];
    }),
  );
}

function strictestSensitivity(evidence: readonly MemoryEvidenceEnvelope[]) {
  const order = ["public", "internal", "confidential", "restricted"] as const;
  return order[Math.max(...evidence.map((item) => order.indexOf(item.sensitivity)), 0)]!;
}

function strictestVisibility(evidence: readonly MemoryEvidenceEnvelope[]) {
  const restricted = evidence.filter((item) => item.visibility.mode === "restricted");
  if (restricted.length > 0) {
    const principals = restricted
      .map(
        (item) =>
          new Map(
            item.visibility.mode === "restricted"
              ? item.visibility.principals.map((ref) => [refKey(ref), ref])
              : [],
          ),
      )
      .reduce((left, right) => new Map([...left].filter(([key]) => right.has(key))));
    if (principals.size > 0)
      return { mode: "restricted" as const, principals: [...principals.values()] };
    return undefined;
  }
  return evidence.every((item) => item.visibility.mode === "public")
    ? { mode: "public" as const }
    : { mode: "host-private" as const };
}

function isExecutionRootRef(ref: MemorySubjectRef): boolean {
  return ["pragma.expert", "pragma.expert-team", "pragma.flow"].includes(ref.type);
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function isConfigurationError(error: unknown): boolean {
  const code = extractionErrorCode(error, "episodic_extraction");
  return code.includes("unavailable") || code.includes("configuration") || code.includes("profile");
}
