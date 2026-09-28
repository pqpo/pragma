import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  createExpertAgentRunContext,
  withExecutionRunScope,
  readExecutionRunScope,
  getExecutionLiveBus,
  type ExpertAgentRunContext,
  type ExpertAgentContextStore,
  type ExecutionEventSubscription,
} from "@pragma/core";
import { ExpertAgentStreamEventSchema, JsonValueSchema, type ExecutionEvent } from "@pragma/shared";
import {
  createFederatedMemoryContextStore,
  createMemoryAttentionController,
  createFileMemoryAttentionStateStore,
  createJevDecisionProvider,
  memoryAttentionScopeDigest,
  type MemoryRecallScope,
  type MemoryAttentionCandidate,
  type MemoryAttentionInput,
} from "@pragma/memory";
import type { createLocalHostMemoryDataPlane } from "./memory-data-plane.ts";
import { resolveMemoryRecallScope } from "./memory-recall-scope.ts";
import { createMemoryAttentionSettingsStore } from "./memory-attention-settings.ts";
import { createRunRedactor } from "./redaction.ts";
import { createMemoryAttentionRequestLimiter } from "./memory-attention-request-limiter.ts";
import type { SecretStore } from "./secrets/secret-store.ts";

type DataPlane = Awaited<ReturnType<typeof createLocalHostMemoryDataPlane>>;
interface MissionBinding {
  readonly missionId: string;
  readonly goal: string;
  readonly projectId?: string;
}
export function createLocalHostMemoryContextService(options: {
  readonly pragmaHome: string;
  readonly data: DataPlane;
  readonly secrets: SecretStore;
  readonly fetch?: typeof fetch;
  readonly onDiagnostic?: ((code: string | undefined) => void) | undefined;
}) {
  const settings = createMemoryAttentionSettingsStore(options);
  const states = createFileMemoryAttentionStateStore(options);
  const missions = new Map<string, MissionBinding>();
  const contexts = new Map<string, { context: ExpertAgentRunContext; missionId: string }>();
  const watches = new Map<
    string,
    { missionId: string; subscription: ExecutionEventSubscription; done: Promise<void> }
  >();
  const observedTools = new Set<string>();
  let closed = false;
  const limit = createMemoryAttentionRequestLimiter();
  const operations = new Map<string, Set<Promise<unknown>>>();
  const alive = (binding: MissionBinding) => !closed && missions.get(binding.missionId) === binding;
  const inMission = async <T>(
    binding: MissionBinding,
    operation: () => Promise<T>,
    fallback: T,
  ): Promise<T> => {
    if (!alive(binding)) return fallback;
    const pending = operation();
    const tasks = operations.get(binding.missionId) ?? new Set<Promise<unknown>>();
    operations.set(binding.missionId, tasks);
    tasks.add(pending);
    try {
      return await pending;
    } finally {
      tasks.delete(pending);
      if (tasks.size === 0) operations.delete(binding.missionId);
    }
  };
  let attentionError: string | undefined;
  const reportUnavailable = (code = "attention_state_unavailable") => {
    attentionError = code;
    options.onDiagnostic?.(code);
  };
  const redactor = createRunRedactor();
  let redactedGeneration: number | undefined;
  const redact = (value: unknown, bytes = 1_200) => {
    const parsed = JsonValueSchema.safeParse(value);
    const clean = parsed.success ? redactor.redactJson(parsed.data) : "[unavailable observation]";
    let text = typeof clean === "string" ? clean : JSON.stringify(clean);
    text = text
      .replace(/(?:Bearer\s+)[\w.\-/+=]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[\w-]+/g, "[REDACTED]")
      .replace(
        /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*["']?[^\s"',;}]+/gi,
        "credential=[REDACTED]",
      );
    return Buffer.from(text)
      .subarray(0, bytes)
      .toString("utf8")
      .replace(/\uFFFD$/u, "");
  };
  const resolveScope = async (
    context: ExpertAgentRunContext | undefined,
    binding?: MissionBinding,
  ) => {
    if (binding !== undefined && !alive(binding)) return undefined;
    const executionId = readExecutionRunScope(context).executionId;
    if (
      binding !== undefined &&
      executionId !== undefined &&
      (await options.data.activity.getExecutionContext(executionId)) === undefined
    ) {
      if (!alive(binding)) return undefined;
      await options.data.registerExecutionContext({
        executionId,
        missionId: binding.missionId,
        ...(binding.projectId === undefined ? {} : { projectId: binding.projectId }),
      });
    }
    const attribution =
      executionId === undefined
        ? undefined
        : await options.data.activity.getExecutionContext(executionId);
    return await resolveMemoryRecallScope(
      options.data.policies,
      context,
      new Date(),
      attribution?.principalRefs ?? [],
    );
  };
  const candidate = async (
    scope: MemoryRecallScope,
    ref: { module: "episodic" | "semantic"; memoryId: string },
  ): Promise<MemoryAttentionCandidate | undefined> => {
    if (ref.module === "episodic") {
      const record = await options.data.episodic.store.getForRecall(scope, ref.memoryId);
      if (record === undefined || record.sensitivity === "restricted") return undefined;
      return {
        ...ref,
        revision: record.revision,
        title: redact(record.goal.text, 180),
        summary: redact(record.summary.text, 800),
      };
    }
    const record = await options.data.semantic.store.getForRecall(scope, ref.memoryId, new Date());
    if (record === undefined || record.sensitivity === "restricted") return undefined;
    return {
      ...ref,
      revision: record.revision,
      title: redact(record.statement, 180),
      summary: redact(record.statement, 800),
    };
  };
  const providerFor = (snapshot: Awaited<ReturnType<typeof settings.get>>) => {
    const provider = createJevDecisionProvider({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      getApiKey: async () => {
        const current = await settings.get();
        if (current.revision !== snapshot.revision || snapshot.secretRef === undefined)
          throw new Error("attention_cancelled");
        const handle = await options.secrets.get(snapshot.secretRef);
        try {
          const key = handle.utf8();
          redactor.registerSecret(key);
          return key;
        } finally {
          handle.dispose();
        }
      },
      beforeRequest: async () => {
        if (
          (await settings.get()).revision !== snapshot.revision ||
          (await options.data.policies.getGlobal()).policy.enabled !== "enabled"
        )
          throw new Error("attention_cancelled");
        await settings.beforeRequest();
      },
    });
    return {
      assessRecall: async (...args: Parameters<typeof provider.assessRecall>) =>
        await limit(args[1], () => provider.assessRecall(...args)),
      assessCandidates: async (...args: Parameters<typeof provider.assessCandidates>) =>
        await limit(args[1], () => provider.assessCandidates(...args)),
      assessAttention: async (...args: Parameters<typeof provider.assessAttention>) =>
        await limit(args[1], () => provider.assessAttention(...args)),
    };
  };
  const controller = createMemoryAttentionController({
    store: states,
    getBinding: async () => {
      if (closed || (await options.data.policies.getGlobal()).policy.enabled !== "enabled")
        return undefined;
      const current = await settings.get();
      if (current.secretRef === undefined) return undefined;
      return {
        generation: current.revision,
        provider: providerFor(current),
        available:
          !current.diagnostic?.permanent && (current.diagnostic?.retryAt ?? 0) <= Date.now(),
      };
    },
    read: candidate,
    search: async (scope, queries, modules) => {
      const result: MemoryAttentionCandidate[] = [];
      for (const query of queries)
        for (const module of modules) {
          const records =
            module === "episodic"
              ? await options.data.episodic.store.searchForRecall(scope, query, 8)
              : await options.data.semantic.store.searchForRecall(scope, query, 8, new Date());
          for (const record of records) {
            const value = await candidate(scope, { module, memoryId: record.id });
            if (
              value !== undefined &&
              !result.some((item) => item.module === module && item.memoryId === value.memoryId)
            )
              result.push(value);
          }
        }
      // Alternate modules so registration order cannot consume the entire budget.
      const groups = modules.map((module) => result.filter((value) => value.module === module));
      const ranked: MemoryAttentionCandidate[] = [];
      for (let i = 0; i < 8; i++)
        for (const group of groups) {
          const value = group[i];
          if (value !== undefined && ranked.length < 8) ranked.push(value);
        }
      return ranked;
    },
    isCurrent: async (input, scope) => {
      const tracked = contexts.get(input.contextId);
      if (closed || tracked?.missionId !== input.missionId || !missions.has(input.missionId))
        return false;
      const current = await resolveScope(tracked.context);
      return (
        current !== undefined &&
        memoryAttentionScopeDigest(current) === memoryAttentionScopeDigest(scope)
      );
    },
    onDiagnostic: async (code, generation) => {
      try {
        await settings.recordDiagnostic(code, generation);
      } catch {
        reportUnavailable();
        return;
      }
      attentionError = undefined;
      options.onDiagnostic?.(code);
    },
  });

  const observe = async (
    binding: MissionBinding,
    context: ExpertAgentRunContext | undefined,
    observation: unknown,
    action: string,
    trigger: MemoryAttentionInput["trigger"],
    toolCallId?: string,
  ) => {
    if (closed || !alive(binding) || context === undefined || action.includes("expert_context"))
      return;
    const run = readExecutionRunScope(context);
    if (run.contextId === undefined) return;
    if (toolCallId !== undefined) {
      const key = `${binding.missionId}:${run.contextId}:${toolCallId}`;
      if (observedTools.has(key)) return;
      observedTools.add(key);
      if (observedTools.size > 512) observedTools.delete(observedTools.values().next().value!);
    }
    const scope = await resolveScope(context, binding);
    if (scope === undefined) return;
    const current = await settings.get();
    if (current.secretRef === undefined || !alive(binding)) return;
    // Register the configured credential before constructing even the first delta.
    if (redactedGeneration !== current.revision) {
      const handle = await options.secrets.get(current.secretRef);
      try {
        redactor.registerSecret(handle.utf8());
      } finally {
        handle.dispose();
      }
      redactedGeneration = current.revision;
    }
    if (!alive(binding)) return;
    contexts.set(run.contextId, { context, missionId: binding.missionId });
    const text = redact(observation, 1_200);
    const goal = redact(binding.goal, 800);
    const concepts = [
      ...new Set(`${text} ${goal} ${action}`.match(/[\p{L}\p{N}_][\p{L}\p{N}_./-]{3,127}/gu) ?? []),
    ]
      .filter(
        (word) =>
          !/^(REDACTED|undefined|null|true|false|outputPreview|toolName|message|text|input|result|toolCallId|kind|details|isError|arguments|payload|type)$/i.test(
            word,
          ),
      )
      .slice(0, 16);
    controller.observe(
      {
        missionId: binding.missionId,
        contextId: run.contextId,
        missionGoal: goal,
        latestObservation: text,
        lastAction: action.slice(0, 200),
        trigger,
        concepts,
      },
      scope,
    );
  };
  const eventContext = async (event: ExecutionEvent, parent = false) => {
    let invocation = await options.data.executionStore.getInvocation(
      event.executionId,
      event.invocationId,
    );
    if (parent && invocation?.parentInvocationId !== undefined)
      invocation = await options.data.executionStore.getInvocation(
        event.executionId,
        invocation.parentInvocationId,
      );
    const execution = await options.data.executionStore.get(event.executionId);
    if (invocation === undefined || execution === undefined || invocation.executorId === undefined)
      return undefined;
    const type =
      execution.definition.kind === "flow"
        ? "pragma.flow"
        : execution.definition.kind === "expert-team"
          ? "pragma.expert-team"
          : "pragma.expert";
    return withExecutionRunScope(
      createExpertAgentRunContext({
        source: { type, id: execution.definition.id },
        attributes: { [EXECUTION_CURRENT_EXPERT_ID_ATTR]: invocation.executorId },
      }),
      {
        executionId: event.executionId,
        invocationId: invocation.invocationId,
        contextId: invocation.contextId,
      },
    );
  };
  const onEvent = async (binding: MissionBinding, event: ExecutionEvent) => {
    if (event.type === "runtime.event") {
      const parsed = ExpertAgentStreamEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      const stream = parsed.data;
      if (stream.type === "tool.completed" || stream.type === "tool.failed") {
        await observe(
          binding,
          await eventContext(event),
          stream.payload,
          stream.payload.toolName,
          stream.type === "tool.failed" ? "new_error" : "new_observation",
          stream.payload.toolCallId,
        );
      }
    } else if (/^invocation\.(succeeded|failed)$/.test(event.type)) {
      const invocation = await options.data.executionStore.getInvocation(
        event.executionId,
        event.invocationId,
      );
      if (invocation?.parentInvocationId !== undefined)
        await observe(
          binding,
          await eventContext(event, true),
          invocation.output ?? invocation.error,
          "child_completed",
          "new_observation",
        );
    } else if (event.type === "human.responded" || event.type === "context.compacted") {
      await observe(binding, await eventContext(event), event.data, event.type, "new_observation");
    }
  };
  const watch = (binding: MissionBinding, context: ExpertAgentRunContext | undefined) => {
    const id = readExecutionRunScope(context).executionId;
    if (id === undefined || watches.has(id) || !alive(binding)) return;
    const subscription = getExecutionLiveBus(options.data.executionStore).subscribeEvents(id);
    const done = (async () => {
      // Targeted replay closes the subscription race; controller digests suppress duplicate observations.
      for (const event of await options.data.executionStore.readEvents(id))
        await onEvent(binding, event);
      for await (const event of subscription) await onEvent(binding, event);
    })()
      .catch(() => reportUnavailable("attention_event_observer_unavailable"))
      .finally(async () => {
        await subscription.close();
        watches.delete(id);
      });
    watches.set(id, { missionId: binding.missionId, subscription, done });
  };
  return {
    settings: {
      ...settings,
      status: async () => {
        const status = await settings.status();
        return attentionError === undefined || status.state === "needs_attention"
          ? status
          : { ...status, state: "degraded" as const, errorCode: attentionError };
      },
      update: async (input: Parameters<typeof settings.update>[0]) => {
        await settings.update(input);
        attentionError = undefined;
        controller.cancelPending();
      },
    },
    controller,
    createContextStore(binding: MissionBinding): ExpertAgentContextStore {
      missions.set(binding.missionId, binding);
      return createFederatedMemoryContextStore(options.data.registry, {
        activity: options.data.activity,
        resolveRecallScope: async (context) =>
          inMission(
            binding,
            async () => {
              const scope = await resolveScope(context, binding);
              try {
                if (
                  scope !== undefined &&
                  (await settings.get()).secretRef !== undefined &&
                  alive(binding)
                )
                  watch(binding, context);
              } catch {
                reportUnavailable();
              }
              return alive(binding) ? scope : undefined;
            },
            undefined,
          ),
        attention: {
          onError: reportUnavailable,
          view: async (context, scope) =>
            inMission(
              binding,
              async () => {
                try {
                  const run = readExecutionRunScope(context);
                  if (run.contextId === undefined || context === undefined) return undefined;
                  contexts.set(run.contextId, { context, missionId: binding.missionId });
                  return await controller.createContextView({
                    missionId: binding.missionId,
                    contextId: run.contextId,
                    scope,
                  });
                } catch {
                  reportUnavailable();
                  return undefined;
                }
              },
              undefined,
            ),
          afterToolResult: async (input) =>
            inMission(
              binding,
              async () => {
                try {
                  await observe(
                    binding,
                    input.context,
                    { input: input.args, result: input.result },
                    input.toolName,
                    input.result.isError ? "new_error" : "new_observation",
                    input.toolCallId,
                  );
                  if (!alive(binding)) return undefined;
                  const scope = await resolveScope(input.context, binding);
                  const contextId = readExecutionRunScope(input.context).contextId;
                  if (scope === undefined || contextId === undefined) return undefined;
                  if (!alive(binding)) return undefined;
                  return await controller.consumeHint({
                    missionId: binding.missionId,
                    contextId,
                    scope,
                  });
                } catch {
                  reportUnavailable();
                  return undefined;
                }
              },
              undefined,
            ),
        },
      });
    },
    async stopMission(missionId: string) {
      missions.delete(missionId);
      await controller.cancelMission(missionId);
      await Promise.allSettled([...(operations.get(missionId) ?? [])]);
      for (const key of observedTools)
        if (key.startsWith(`${missionId}:`)) observedTools.delete(key);
      for (const [id, tracked] of contexts)
        if (tracked.missionId === missionId) contexts.delete(id);
      for (const [id, value] of watches) {
        if (value.missionId === missionId) {
          await value.subscription.close();
          await value.done;
          watches.delete(id);
        }
      }
    },
    async stop() {
      closed = true;
      missions.clear();
      contexts.clear();
      await controller.stop();
      await Promise.allSettled([...operations.values()].flatMap((tasks) => [...tasks]));
      await Promise.all(
        [...watches.values()].map(async (value) => {
          await value.subscription.close();
          await value.done;
        }),
      );
      watches.clear();
    },
  };
}
