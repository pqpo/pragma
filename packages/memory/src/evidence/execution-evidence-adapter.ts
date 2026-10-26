import { createHash } from "node:crypto";

import type { CanonicalEventFeed } from "@pragma/core";
import { readToolResult } from "@pragma/core";
import {
  ExecutionEventSchema,
  ExpertAgentStreamEventSchema,
  InvocationMessageAppendedEventSchema,
  MemoryEvidenceEnvelopeSchema,
  MemorySafeExecutionMessagePayloadSchema,
  MemorySafeTerminalPayloadSchema,
  MemorySafeToolEventPayloadSchema,
  MemoryToolContentPayloadSchema,
  type AgentMessage,
  type CanonicalEventEnvelope,
  type EffectiveMemoryPolicy,
  type ExecutionEvent,
  type MemoryEvidenceEnvelope,
  type MemorySubjectRef,
  type ToolContent,
} from "@pragma/shared";

import type { MemoryExtractionSettingsStore } from "../pipeline/extraction-settings.ts";
import type { DeferredExecutionCaptureStore } from "./deferred-execution-capture.ts";
import { redactMemoryValue } from "./redact.ts";
import type { MemoryEvidencePublisher } from "./evidence-feed.ts";
import type {
  MemoryConsumerCheckpointStore,
  MemoryDeadLetterStore,
} from "../pipeline/pipeline-state-store.ts";
import type { MemoryPolicyStore } from "../policy/memory-policy-store.ts";
import { MEMORY_CURATOR_ID } from "../curator.ts";
import type {
  MemoryActivityStore,
  MemoryCaptureDecision,
} from "../activity/memory-activity-store.ts";

export const EXECUTION_EVIDENCE_ADAPTER_ID = "pragma.memory.execution-evidence-adapter";

export interface ExecutionEvidenceAdapter {
  runOnce(): Promise<{
    readonly published: number;
    readonly skipped: number;
    readonly deferred?: number;
  }>;
}

export function createExecutionEvidenceAdapter(options: {
  readonly source: CanonicalEventFeed;
  readonly publisher: MemoryEvidencePublisher;
  readonly checkpoints: MemoryConsumerCheckpointStore;
  readonly deadLetters: MemoryDeadLetterStore;
  readonly policies: Pick<MemoryPolicyStore, "resolveAt">;
  /** Host-owned origin check. Unavailable identity is deferred without publishing Evidence. */
  readonly excludeExecution?: ((event: CanonicalEventEnvelope) => Promise<boolean>) | undefined;
  readonly deferred?: DeferredExecutionCaptureStore | undefined;
  readonly extractionSettings?: Pick<MemoryExtractionSettingsStore, "get"> | undefined;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly activity?:
    Pick<MemoryActivityStore, "recordCapture" | "getExecutionContext"> | undefined;
}): ExecutionEvidenceAdapter {
  const now = options.now ?? (() => new Date());
  return {
    async runOnce() {
      const state = await options.checkpoints.read(EXECUTION_EVIDENCE_ADAPTER_ID);
      const page = await options.source.read({
        after: { sequence: state.sequence },
        limit: options.batchSize ?? 100,
      });
      const pending = (await options.deferred?.next(options.batchSize ?? 100)) ?? [];
      const replay: (typeof page.items)[number][] = [];
      for (const entry of pending) {
        const original = await options.source.read({
          after: { sequence: entry.sequence - 1 },
          limit: 1,
        });
        const item = original.items[0];
        if (
          item?.cursor.sequence === entry.sequence &&
          item.kind === "event" &&
          item.event.eventId !== entry.eventId
        )
          throw new Error("memory_execution_capture_source_changed");
        if (
          item?.cursor.sequence === entry.sequence &&
          (item.kind === "unreadable" || item.event.eventId === entry.eventId)
        )
          replay.push(item);
        else await options.deferred!.remove(entry.eventId); // Owner deletion removed the source.
      }
      if (page.nextCursor.sequence === state.sequence && replay.length === 0) {
        const deferred = (await options.deferred?.inspect())?.pending ?? 0;
        if (deferred > 0) return { published: 0, skipped: 0, deferred };
        return { published: 0, skipped: 0 };
      }
      // Configuration failures must leave the canonical checkpoint intact for replay.
      const settings = await options.extractionSettings?.get().catch((cause: unknown) => {
        throw Object.assign(new Error("memory_extraction_settings_unavailable", { cause }), {
          code: "memory_extraction_settings_unavailable",
          retryable: true,
        });
      });
      const evidence: MemoryEvidenceEnvelope[] = [];
      const captureDecisions: MemoryCaptureDecision[] = [];
      const exclusions = new Map<string, boolean>();
      const unresolved = new Set<string>();
      const pendingIds = new Set(pending.map((entry) => entry.eventId));
      const settled = new Set<string>();
      const seen = new Set<number>();
      let skipped = 0;
      for (const item of [...replay, ...page.items]) {
        if (seen.has(item.cursor.sequence)) continue;
        seen.add(item.cursor.sequence);
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
          if (item.eventId !== undefined && pendingIds.has(item.eventId)) settled.add(item.eventId);
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
        if (options.excludeExecution !== undefined) {
          const executionId = item.event.correlationId ?? item.event.eventId;
          let excluded = exclusions.get(executionId);
          if (excluded === undefined) {
            try {
              if (unresolved.has(executionId))
                throw new Error("memory_execution_origin_unavailable");
              excluded = await options.excludeExecution(item.event);
            } catch (error) {
              if (options.deferred === undefined) throw error;
              unresolved.add(executionId);
              await options.deferred.put({
                eventId: item.event.eventId,
                sequence: item.cursor.sequence,
              });
              continue;
            }
            exclusions.set(executionId, excluded);
          }
          if (pendingIds.has(item.event.eventId)) settled.add(item.event.eventId);
          if (excluded) {
            addCaptureDecision(captureDecisions, item.event, "skipped", "system_memory_excluded");
            skipped += 1;
            continue;
          }
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
          const executionId = item.event.correlationId;
          const conversationRef =
            executionId === undefined
              ? undefined
              : (await options.activity?.getExecutionContext(executionId))?.conversationRef;
          const mapped = mapExecutionEvent(item.event, policy, attribution, conversationRef);
          if (mapped === undefined) {
            addCaptureDecision(captureDecisions, item.event, "skipped", "not_memory_evidence");
            skipped += 1;
          } else {
            evidence.push(mapped);
            const allowedModules = (["episodic", "semantic"] as const).filter(
              (module) => settings?.allowToolAssisted[module] === true,
            );
            if (allowedModules.length > 0) {
              const content = toolContent(item.event);
              if (content !== undefined) {
                const text = String(redactMemoryValue(content.text));
                evidence.push({
                  ...mapped,
                  messageId: `${mapped.messageId}:tool-content:v1`,
                  topic: "execution.tool.content",
                  schemaRef: "pragma.memory.tool-content/v1",
                  payload: MemoryToolContentPayloadSchema.parse({
                    ...content,
                    text: text.slice(0, 64000),
                    completeness: text.length > 64000 ? "truncated" : content.completeness,
                    allowedModules,
                  }),
                });
              }
            }
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
      for (const eventId of settled) await options.deferred?.remove(eventId);
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
      const deferred = (await options.deferred?.inspect())?.pending ?? 0;
      return { published: evidence.length, skipped, ...(deferred === 0 ? {} : { deferred }) };
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
  conversationRef?: MemorySubjectRef,
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
      conversationRef,
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
      conversationRef,
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
      conversationRef,
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
      conversationRef,
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
      conversationRef,
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
      conversationRef,
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
  conversationRef?: MemorySubjectRef,
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
    ...(conversationRef === undefined ? {} : { conversationRef }),
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

function toolContent(canonical: CanonicalEventEnvelope):
  | {
      toolCallId: string;
      toolName: string;
      phase: "started" | "completed" | "failed";
      text: string;
      completeness: "full" | "preview";
    }
  | undefined {
  const event = ExecutionEventSchema.parse(canonical.payload);
  if (event.type === "invocation.message.appended") {
    const message = InvocationMessageAppendedEventSchema.parse(event).data.message;
    if (message.role !== "toolResult") return undefined;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return {
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      phase: message.isError ? "failed" : "completed",
      text,
      completeness: "full",
    };
  }
  if (event.type !== "runtime.event") return undefined;
  const runtime = ExpertAgentStreamEventSchema.parse(event.data);
  if (runtime.type === "tool.started" && runtime.payload.inputPreview !== undefined)
    return {
      toolCallId: runtime.payload.toolCallId,
      toolName: runtime.payload.toolName,
      phase: "started",
      text:
        typeof runtime.payload.inputPreview === "string"
          ? runtime.payload.inputPreview
          : JSON.stringify(redactMemoryValue(runtime.payload.inputPreview)),
      completeness: "preview",
    };
  if (runtime.type === "tool.completed" && runtime.payload.outputPreview !== undefined) {
    const result = readToolResult(runtime.payload.outputPreview);
    return {
      toolCallId: runtime.payload.toolCallId,
      toolName: runtime.payload.toolName,
      phase: "completed",
      text:
        result !== undefined
          ? toolEvidenceText(result.content)
          : typeof runtime.payload.outputPreview === "string"
            ? runtime.payload.outputPreview
            : JSON.stringify(redactMemoryValue(runtime.payload.outputPreview)),
      completeness: "preview",
    };
  }
  if (runtime.type === "tool.failed")
    return {
      toolCallId: runtime.payload.toolCallId,
      toolName: runtime.payload.toolName,
      phase: "failed",
      text: runtime.payload.message,
      completeness: "preview",
    };
  return undefined;
}

/** Keep readable evidence ahead of the capture limit; encoded media is not text evidence. */
function toolEvidenceText(content: readonly ToolContent[]): string {
  return content
    .flatMap((item) => {
      switch (item.type) {
        case "text":
          return [item.text];
        case "resource":
          return [
            `Resource ${item.resource.uri}${typeof item.resource.text === "string" ? `\n${item.resource.text}` : ""}`,
          ];
        case "resource_link":
          return [[item.name, item.uri, item.title, item.description].filter(Boolean).join("\n")];
        case "image":
        case "audio":
          return [];
      }
    })
    .join("\n");
}
