import type { MemoryEvidenceEnvelope, MemorySubjectRef } from "@pragma/shared";

import { createSemanticMemoryContextProvider } from "./context.ts";
import {
  SemanticExecutionSubjectContextSchema,
  SemanticExtractionInputSchema,
  SemanticExtractionOutputSchema,
  type SemanticMemoryExtractor,
} from "./schema.ts";
import { createSemanticMemoryStore, type SemanticMemoryStore } from "./store.ts";
import type { MemoryModule } from "../pipeline/memory-module.ts";

export interface SemanticMemoryModule extends MemoryModule {
  readonly store: SemanticMemoryStore;
  setExtractor(extractor: SemanticMemoryExtractor | undefined): Promise<void>;
  registerExecutionSubjects(input: {
    readonly executionId: string;
    readonly subjectRefs: readonly MemorySubjectRef[];
    readonly registeredAt?: string | undefined;
  }): Promise<void>;
  close(): void;
}

export async function createSemanticMemoryModule(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly extractor?: SemanticMemoryExtractor | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): Promise<SemanticMemoryModule> {
  const store = await createSemanticMemoryStore(options);
  const now = options.now ?? (() => new Date());
  let extractor = options.extractor;

  return {
    descriptor: {
      id: "pragma.memory.semantic",
      version: "1.0.0",
      pathPrefix: "semantic",
      storageModel: "dynamic-projection",
      purpose: "projection",
      contextLayers: {
        usagePrompt:
          "Use Semantic Memory for current beliefs, preferences, constraints, and facts. Check confidence, freshness, conflicts, and Evidence before relying on important claims.",
        summaryPath: "summary.md",
        indexPath: "index.md",
        itemsPrefix: "items/",
        evidencePrefix: "evidence/",
        summaryMaxBytes: 2_048,
        indexMaxBytes: 4_096,
      },
    },
    subscriptions: [
      { topic: "execution.message.appended", schemaRefs: ["pragma.memory.execution-message/v2"] },
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
      return createSemanticMemoryContextProvider(store, scope, now);
    },
    async consume(envelopes) {
      await store.ingest(envelopes);
      return {};
    },
    async runBackgroundOnce() {
      if (extractor === undefined) return;
      const job = await store.claimDueJob(now());
      if (job === undefined) return;
      try {
        if (await store.hasAppliedJob(job.id)) {
          await store.completePreviouslyApplied(job);
          return;
        }
        const subjectContext = await store.getSubjectContext(job.executionId);
        if (subjectContext === undefined) throw new Error("semantic_subject_context_missing");
        const evidence = sanitizeEvidence(await store.readEvidence(job.executionId));
        if (evidence.some((item) => item.sensitivity === "restricted")) {
          await store.completeRejected(job, "sensitive");
          return;
        }
        if (!hasTextEvidence(evidence)) {
          await store.completeRejected(job, "insufficient-evidence");
          return;
        }
        const visibility = strictestVisibility(evidence);
        if (visibility === undefined) {
          await store.completeRejected(job, "policy");
          return;
        }
        const attribution = resolveAttribution(evidence);
        const allowedSubjectRefs = uniqueRefs([
          ...subjectContext.subjectRefs,
          attribution.rootRef,
          ...attribution.producerRefs,
        ]);
        const input = SemanticExtractionInputSchema.parse({
          schemaVersion: "pragma.memory-semantic-extraction-input/v1",
          jobId: job.id,
          executionId: job.executionId,
          allowedSubjectRefs,
          evidence,
        });
        const extracted = await extractor.extract(input);
        const output = SemanticExtractionOutputSchema.parse(extracted.output);
        if (!output.retain) {
          await store.completeRejected(job, output.reason);
          return;
        }
        assertCandidateRefs(output.facts, evidence, allowedSubjectRefs);
        await store.completeRetained({
          job,
          candidates: output.facts,
          evidence,
          rootRef: attribution.rootRef,
          producerRefs: attribution.producerRefs,
          visibility,
          sensitivity: strictestSensitivity(evidence),
          extractor: extracted.provenance,
          now: now(),
        });
      } catch (error) {
        await store.fail({
          job,
          errorCode: errorCode(error),
          now: now(),
          retry: isConfigurationError(error) ? "configuration" : "transient",
        });
      }
    },
    async setExtractor(next) {
      extractor = next;
      if (next !== undefined) await store.wakeNeedsAttention(now());
    },
    async registerExecutionSubjects(input) {
      await store.registerSubjectContext(
        SemanticExecutionSubjectContextSchema.parse({
          schemaVersion: "pragma.memory-semantic-execution-subject-context/v1",
          executionId: input.executionId,
          subjectRefs: uniqueRefs(input.subjectRefs),
          registeredAt: input.registeredAt ?? now().toISOString(),
        }),
      );
    },
    store,
    close() {
      store.close();
    },
  };
}

function hasTextEvidence(evidence: readonly MemoryEvidenceEnvelope[]): boolean {
  return evidence.some((item) => {
    if (item.schemaRef !== "pragma.memory.execution-message/v2") return false;
    const payload = item.payload as { readonly message?: { readonly text?: unknown } };
    return typeof payload.message?.text === "string" && payload.message.text.trim() !== "";
  });
}

function assertCandidateRefs(
  facts: readonly {
    readonly subjectRefs: readonly MemorySubjectRef[];
    readonly evidenceRefs: readonly string[];
    readonly reviewAt?: string | undefined;
    readonly expiresAt?: string | undefined;
  }[],
  evidence: readonly MemoryEvidenceEnvelope[],
  subjects: readonly MemorySubjectRef[],
): void {
  const evidenceIds = new Set(evidence.map((item) => item.messageId));
  const subjectIds = new Set(subjects.map(refKey));
  const occurredAt = new Map(evidence.map((item) => [item.messageId, item.occurredAt]));
  for (const fact of facts) {
    for (const ref of fact.subjectRefs) {
      if (!subjectIds.has(refKey(ref))) throw new Error("semantic_subject_ref_invalid");
    }
    for (const ref of fact.evidenceRefs) {
      if (!evidenceIds.has(ref)) throw new Error("semantic_evidence_ref_invalid");
    }
    const observedAt = fact.evidenceRefs
      .map((ref) => occurredAt.get(ref)!)
      .toSorted()
      .at(-1)!;
    if (fact.reviewAt !== undefined && fact.reviewAt <= observedAt) {
      throw new Error("semantic_review_time_invalid");
    }
    if (fact.expiresAt !== undefined && fact.expiresAt <= observedAt) {
      throw new Error("semantic_expiry_time_invalid");
    }
  }
}

function resolveAttribution(evidence: readonly MemoryEvidenceEnvelope[]): {
  readonly rootRef: MemorySubjectRef;
  readonly producerRefs: readonly MemorySubjectRef[];
} {
  const roots = uniqueRefs(
    evidence.flatMap((item) => (item.attribution ? [item.attribution.rootRef] : [])),
  );
  if (
    roots.length !== 1 ||
    !["pragma.expert", "pragma.expert-team", "pragma.flow"].includes(roots[0]!.type)
  ) {
    throw new Error("semantic_root_attribution_invalid");
  }
  return {
    rootRef: roots[0]!,
    producerRefs: uniqueRefs(evidence.flatMap((item) => item.attribution?.producerRefs ?? [])),
  };
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
    return principals.size === 0
      ? undefined
      : { mode: "restricted" as const, principals: [...principals.values()] };
  }
  return evidence.every((item) => item.visibility.mode === "public")
    ? { mode: "public" as const }
    : { mode: "host-private" as const };
}

function sanitizeEvidence(
  evidence: readonly MemoryEvidenceEnvelope[],
): readonly MemoryEvidenceEnvelope[] {
  return evidence.map((item) => ({ ...item, payload: redactValue(item.payload) }));
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_CREDENTIAL]")
      .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[REDACTED_CREDENTIAL]")
      .replace(
        /((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
        "$1[REDACTED_CREDENTIAL]",
      );
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function errorCode(error: unknown): string {
  return error instanceof Error
    ? error.message.split(":", 1)[0] || "semantic_extraction_failed"
    : "semantic_extraction_failed";
}

function isConfigurationError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code.includes("unavailable") ||
    code.includes("configuration") ||
    code.includes("profile") ||
    code === "semantic_subject_context_missing"
  );
}
