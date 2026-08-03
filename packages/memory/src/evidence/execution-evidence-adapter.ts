import { createHash } from "node:crypto";

import type { CanonicalEventFeed } from "@pragma/core";
import {
  ExecutionEventSchema,
  ExpertAgentStreamEventSchema,
  InvocationMessageAppendedEventSchema,
  MemoryEvidenceEnvelopeSchema,
  MemorySafeExecutionMessagePayloadSchema,
  MemorySafeTerminalPayloadSchema,
  MemorySafeToolEventPayloadSchema,
  type AgentMessage,
  type CanonicalEventEnvelope,
  type EffectiveMemoryPolicy,
  type ExecutionEvent,
  type MemoryEvidenceEnvelope,
  type MemorySubjectRef,
} from "@pragma/shared";

import type { MemoryEvidencePublisher } from "./evidence-feed.ts";
import type {
  MemoryConsumerCheckpointStore,
  MemoryDeadLetterStore,
} from "../pipeline/pipeline-state-store.ts";
import type { MemoryPolicyStore } from "../policy/memory-policy-store.ts";
import { MEMORY_CURATOR_ID } from "../curator.ts";
import type { MemoryActivityStore, MemoryCaptureDecision } from "../activity/memory-activity-store.ts";

export const EXECUTION_EVIDENCE_ADAPTER_ID = "pragma.memory.execution-evidence-adapter";

export interface ExecutionEvidenceAdapter {
  runOnce(): Promise<{ readonly published: number; readonly skipped: number }>;
}

export function createExecutionEvidenceAdapter(options: {
  readonly source: CanonicalEventFeed;
  readonly publisher: MemoryEvidencePublisher;
  readonly checkpoints: MemoryConsumerCheckpointStore;
  readonly deadLetters: MemoryDeadLetterStore;
  readonly policies: Pick<MemoryPolicyStore, "resolveAt">;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly activity?: Pick<MemoryActivityStore, "recordCapture"> | undefined;
}): ExecutionEvidenceAdapter {
  const now = options.now ?? (() => new Date());
  return {
    async runOnce() {
      const state = await options.checkpoints.read(EXECUTION_EVIDENCE_ADAPTER_ID);
      const page = await options.source.read({
        after: { sequence: state.sequence },
        limit: options.batchSize ?? 100,
      });
      if (page.nextCursor.sequence === state.sequence) {
        return { published: 0, skipped: 0 };
      }
      const evidence: MemoryEvidenceEnvelope[] = [];
      const captureDecisions: MemoryCaptureDecision[] = [];
      let skipped = 0;
      for (const item of page.items) {
        if (item.kind === "unreadable") {
          await options.deadLetters.put({
            schemaVersion: "pragma.memory-dead-letter/v1",
            consumerId: EXECUTION_EVIDENCE_ADAPTER_ID,
            messageId: item.eventId ?? `canonical-sequence:${item.cursor.sequence}`,
            sequence: item.cursor.sequence,
            errorCode: item.errorCode,
            failedAt: now().toISOString(),
          });
          skipped += 1;
          continue;
        }
        if (item.event.topic !== "pragma.execution.event.committed") {
          skipped += 1;
          continue;
        }
        const attribution = eventAttribution(item.event);
        if (
          attribution.rootRef?.type === "pragma.expert" &&
          attribution.rootRef.id === MEMORY_CURATOR_ID
        ) {
          addCaptureDecision(captureDecisions, item.event, "skipped", "memory_curator_excluded");
          skipped += 1;
          continue;
        }
        let policy: EffectiveMemoryPolicy;
        try {
          policy = await options.policies.resolveAt({
            rootRef: attribution.rootRef,
            producerRefs: attribution.producerRefs,
            occurredAt: item.event.occurredAt,
          });
        } catch {
          addCaptureDecision(captureDecisions, item.event, "failed", "memory_policy_unavailable");
          await options.deadLetters.put({
            schemaVersion: "pragma.memory-dead-letter/v1",
            consumerId: EXECUTION_EVIDENCE_ADAPTER_ID,
            messageId: item.event.eventId,
            sequence: item.cursor.sequence,
            errorCode: "memory_policy_unavailable",
            failedAt: now().toISOString(),
          });
          skipped += 1;
          continue;
        }
        if (!policy.capture) {
          addCaptureDecision(captureDecisions, item.event, "skipped", "capture_disabled");
          skipped += 1;
          continue;
        }
        try {
          if (item.event.schemaRef !== "pragma.execution-event/v5") {
            throw new Error(`Unsupported Execution event schema: ${item.event.schemaRef}`);
          }
          const mapped = mapExecutionEvent(item.event, policy, attribution);
          if (mapped === undefined) {
            addCaptureDecision(captureDecisions, item.event, "skipped", "not_memory_evidence");
            skipped += 1;
          } else {
            evidence.push(mapped);
            addCaptureDecision(captureDecisions, item.event, "published", "evidence_published");
          }
        } catch {
          addCaptureDecision(captureDecisions, item.event, "failed", "execution_evidence_invalid");
          await options.deadLetters.put({
            schemaVersion: "pragma.memory-dead-letter/v1",
            consumerId: EXECUTION_EVIDENCE_ADAPTER_ID,
            messageId: item.event.eventId,
            sequence: item.cursor.sequence,
            errorCode: "execution_evidence_invalid",
            failedAt: now().toISOString(),
          });
          skipped += 1;
        }
      }
      await options.publisher.publish(evidence);
      await Promise.all(
        captureDecisions.map(async (decision) => {
          await options.activity?.recordCapture(decision).catch(() => undefined);
        }),
      );
      await options.checkpoints.update(EXECUTION_EVIDENCE_ADAPTER_ID, (current) => ({
        ...current,
        sequence: page.nextCursor.sequence,
        processed: current.processed + evidence.length,
        skipped: current.skipped + skipped,
        updatedAt: now().toISOString(),
      }));
      return { published: evidence.length, skipped };
    },
  };
}

function addCaptureDecision(
  decisions: MemoryCaptureDecision[],
  event: CanonicalEventEnvelope,
  outcome: MemoryCaptureDecision["outcome"],
  reason: string,
): void {
  if (event.correlationId === undefined) return;
  decisions.push({
    schemaVersion: "pragma.memory-capture-activity/v1",
    sourceEventId: event.eventId,
    executionId: event.correlationId,
    outcome,
    reason,
    occurredAt: event.occurredAt,
  });
}

function mapExecutionEvent(
  canonical: CanonicalEventEnvelope,
  policy: EffectiveMemoryPolicy,
  attribution: ReturnType<typeof eventAttribution>,
): MemoryEvidenceEnvelope | undefined {
  const bindingRefs = attribution.bindingRefs;
  const event = ExecutionEventSchema.parse(canonical.payload);
  if (event.type === "invocation.message.appended") {
    const message = InvocationMessageAppendedEventSchema.parse(event).data.message;
    const safe = toSafeExecutionMessage(message);
    if (safe === undefined) return undefined;
    return evidence(
      canonical,
      event,
      "execution.message.appended",
      "pragma.memory.execution-message/v2",
      MemorySafeExecutionMessagePayloadSchema.parse({ message: safe }),
      policy,
      bindingRefs,
      attribution,
    );
  }
  if (/^(invocation|execution)\.(succeeded|failed|cancelled|interrupted)$/.test(event.type)) {
    const scope = event.type.startsWith("invocation.") ? "invocation" : "execution";
    return evidence(
      canonical,
      event,
      `execution.${scope}.terminal`,
      `pragma.memory.${scope}-terminal/v2`,
      MemorySafeTerminalPayloadSchema.parse({ outcome: event.type.split(".")[1] }),
      policy,
      bindingRefs,
      attribution,
      "internal",
    );
  }
  if (event.type === "handoff.file.registered") {
    return evidence(
      canonical,
      event,
      "artifact.handoff.registered",
      "pragma.memory.handoff-artifact/v1",
      event.data,
      policy,
      bindingRefs,
      attribution,
    );
  }
  if (event.type !== "runtime.event") return undefined;
  const runtime = ExpertAgentStreamEventSchema.parse(event.data);
  if (runtime.type === "tool.started") {
    return evidence(
      canonical,
      event,
      "execution.tool.started",
      "pragma.memory.tool-event/v2",
      MemorySafeToolEventPayloadSchema.parse({
        toolCallId: runtime.payload.toolCallId,
        toolName: runtime.payload.toolName,
        phase: "started",
      }),
      policy,
      bindingRefs,
      attribution,
    );
  }
  if (runtime.type === "tool.completed" || runtime.type === "tool.failed") {
    return evidence(
      canonical,
      event,
      `execution.${runtime.type}`,
      "pragma.memory.tool-event/v2",
      MemorySafeToolEventPayloadSchema.parse({
        toolCallId: runtime.payload.toolCallId,
        toolName: runtime.payload.toolName,
        phase: runtime.type === "tool.completed" ? "completed" : "failed",
      }),
      policy,
      bindingRefs,
      attribution,
    );
  }
  if (runtime.type === "artifact.created") {
    return evidence(
      canonical,
      event,
      "artifact.created",
      "pragma.memory.artifact-event/v1",
      runtime.payload,
      policy,
      bindingRefs,
      attribution,
    );
  }
  return undefined;
}

function evidence(
  canonical: CanonicalEventEnvelope,
  event: ExecutionEvent,
  topic: string,
  schemaRef: string,
  payload: unknown,
  policy: EffectiveMemoryPolicy,
  bindingRefs: readonly MemorySubjectRef[],
  attribution: ReturnType<typeof eventAttribution>,
  sensitivity: "internal" | "confidential" = "confidential",
): MemoryEvidenceEnvelope {
  const messageId = createHash("sha256")
    .update(JSON.stringify(["pragma.execution-evidence-adapter/v2", canonical.eventId, topic]))
    .digest("hex");
  return MemoryEvidenceEnvelopeSchema.parse({
    schemaVersion: "pragma.memory-evidence/v1",
    messageId,
    topic,
    schemaRef,
    sourceRef: {
      type: "pragma.execution-event",
      id: event.eventId,
      canonicalEventId: canonical.eventId,
      cursor: String(event.cursor.sequence),
    },
    subjectRefs: uniqueRefs([
      { type: "pragma.execution", id: event.executionId },
      { type: "pragma.invocation", id: event.invocationId },
      ...bindingRefs,
    ]),
    correlationId: event.executionId,
    causationId: canonical.eventId,
    occurredAt: event.occurredAt,
    visibility: { mode: "host-private" },
    sensitivity,
    bindings: bindingRefs.map((consumerRef) => ({ consumerRef, access: "allow" as const })),
    ...(attribution.rootRef === undefined
      ? {}
      : {
          attribution: {
            rootRef: attribution.rootRef,
            producerRefs: attribution.producerRefs,
          },
        }),
    policySnapshot: policy,
    payload,
  });
}

function toSafeExecutionMessage(message: AgentMessage) {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n");
    return text.trim() === "" ? undefined : { role: "user" as const, text };
  }
  if (message.role === "assistant") {
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (text.trim() === "") return undefined;
    return { role: "assistant" as const, text, stopReason: message.stopReason };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool" as const,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status: message.isError ? ("failed" as const) : ("succeeded" as const),
    };
  }
  if (message.role === "branchSummary") {
    return { role: "summary" as const, kind: "branch" as const, text: message.summary };
  }
  if (message.role === "compactionSummary") {
    return { role: "summary" as const, kind: "compaction" as const, text: message.summary };
  }
  return undefined;
}

function eventAttribution(canonical: CanonicalEventEnvelope): {
  readonly rootRef?: MemorySubjectRef | undefined;
  readonly producerRefs: readonly MemorySubjectRef[];
  readonly bindingRefs: readonly MemorySubjectRef[];
} {
  const rootRef = canonical.relatedRefs.find(
    (related) => related.relation === "pragma.execution-root",
  )?.ref;
  const producerRefs = canonical.relatedRefs
    .filter((related) => related.relation === "pragma.event-producer")
    .map((related) => related.ref);
  return {
    ...(rootRef === undefined ? {} : { rootRef }),
    producerRefs: uniqueRefs(producerRefs),
    bindingRefs: uniqueRefs([...(rootRef === undefined ? [] : [rootRef]), ...producerRefs]),
  };
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((ref) => [`${ref.type}\0${ref.id}`, ref])).values()];
}
