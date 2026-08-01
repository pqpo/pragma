import type { MemoryEvidenceEnvelope, MemorySubjectRef } from "@pragma/shared";

import { createEpisodicMemoryContextProvider } from "./context.ts";
import {
  EpisodicExtractionInputSchema,
  EpisodicExtractionOutputSchema,
  EpisodicMemoryRecordSchema,
  type EpisodicMemoryExtractor,
} from "./schema.ts";
import { createEpisodicMemoryStore, episodicMemoryId, type EpisodicMemoryStore } from "./store.ts";
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
          "Use Episodic Memory for historical precedent: what was attempted, what failed, how recovery worked, and what outcome followed. It is not current truth.",
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
    contextProvider: createEpisodicMemoryContextProvider(store),
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
          await store.completeRejected(job);
          return;
        }
        if (isLowValue(evidence)) {
          await store.completeRejected(job);
          return;
        }
        const previousEpisode = await store.getByExecution(job.executionId);
        if (previousEpisode?.terminalMessageId === job.terminalMessageId) {
          await store.completeRetained({ job, record: previousEpisode, evidence });
          return;
        }
        const input = EpisodicExtractionInputSchema.parse({
          schemaVersion: "pragma.memory-episodic-extraction-input/v1",
          jobId: job.id,
          executionId: job.executionId,
          ...(previousEpisode === undefined ? {} : { previousEpisode }),
          evidence,
        });
        const extracted = await extractor.extract(input);
        const output = EpisodicExtractionOutputSchema.parse(extracted.output);
        if (!output.retain) {
          await store.completeRejected(job);
          return;
        }
        assertEvidenceRefs(output, new Set(evidence.map((item) => item.messageId)));
        const timestamp = now().toISOString();
        const bindings = intersectBindings(evidence);
        const rootAndProducerRefs = uniqueRefs(
          evidence.flatMap((item) =>
            item.subjectRefs.filter(
              (ref) => ref.type !== "pragma.execution" && ref.type !== "pragma.invocation",
            ),
          ),
        );
        const record = EpisodicMemoryRecordSchema.parse({
          schemaVersion: "pragma.memory-episodic/v1",
          id: episodicMemoryId(job.executionId),
          revision: (previousEpisode?.revision ?? 0) + 1,
          executionId: job.executionId,
          terminalMessageId: job.terminalMessageId,
          rootRefs: rootAndProducerRefs.slice(0, 1),
          producerRefs: rootAndProducerRefs,
          language: output.language,
          goal: output.goal,
          summary: output.summary,
          attempts: output.attempts,
          failuresAndRecoveries: output.failuresAndRecoveries,
          outcome: output.outcome,
          artifactRefs: artifactRefs(evidence),
          evidenceRefs: collectEvidenceRefs(output),
          visibility: strictestVisibility(evidence),
          sensitivity: strictestSensitivity(evidence),
          bindings,
          valueScore: output.valueScore,
          status: "active",
          extractor: extracted.provenance,
          createdAt: previousEpisode?.createdAt ?? timestamp,
          updatedAt: timestamp,
        });
        await store.completeRetained({ job, record, evidence });
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

function intersectBindings(evidence: readonly MemoryEvidenceEnvelope[]): MemorySubjectRef[] {
  const sets = evidence.map(
    (item) =>
      new Map(
        item.bindings
          .filter((binding) => binding.access === "allow")
          .map((binding) => [refKey(binding.consumerRef), binding.consumerRef]),
      ),
  );
  if (sets.length === 0) return [];
  return [...(sets[0]?.entries() ?? [])]
    .filter(([key]) => sets.every((set) => set.has(key)))
    .map(([, ref]) => ref);
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
    return { mode: "host-private" as const };
  }
  return evidence.every((item) => item.visibility.mode === "public")
    ? { mode: "public" as const }
    : { mode: "host-private" as const };
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

function refKey(ref: MemorySubjectRef): string {
  return `${ref.type}\0${ref.id}`;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message.split(":", 1)[0] || "episodic_extraction_failed";
  return "episodic_extraction_failed";
}

function isConfigurationError(error: unknown): boolean {
  const code = errorCode(error);
  return code.includes("unavailable") || code.includes("configuration") || code.includes("profile");
}
