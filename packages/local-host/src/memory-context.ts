import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  PragmaPaths,
  decodePragmaPathSegment,
  createExpertAgentRunContext,
  withExecutionRunScope,
  readExecutionRunScope,
  getExecutionLiveBus,
  type ExpertAgentRunContext,
  type ExpertAgentContextStore,
  type ExecutionEventSubscription,
} from "@pragma/core";
import {
  BoundedLruCache,
  ExpertPromptInputSchema,
  ExpertAgentStreamEventSchema,
  JsonValueSchema,
  type ExecutionEvent,
} from "@pragma/shared";
import {
  createFederatedMemoryContextStore,
  createMemoryAttentionController,
  createFileMemoryAttentionStateStore,
  createJevDecisionProvider,
  memoryAttentionScopeDigest,
  renderSemanticFact,
  type MemoryRecallScope,
  type MemoryAttentionCandidate,
  type MemoryAttentionInput,
} from "@pragma/memory";
import type { createLocalHostMemoryDataPlane } from "./memory-data-plane.ts";
import { resolveMemoryRecallScope } from "./memory-recall-scope.ts";
import { createMemoryAttentionSettingsStore } from "./memory-attention-settings.ts";
import { createRunRedactor } from "./redaction.ts";
import { createMemoryAttentionRequestLimiter } from "./memory-attention-request-limiter.ts";
import { createLocalHostMemoryRetrieval } from "./memory-retrieval.ts";
import { selectedMemoryText, redactMemoryProjection } from "@pragma/memory";
import { memoryDetailSegments } from "./memory-detail.ts";
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
  readonly backgroundIndexing?: boolean;
  readonly onDiagnostic?: ((code: string | undefined) => void) | undefined;
}) {
  const settings = createMemoryAttentionSettingsStore(options);
  const limit = createMemoryAttentionRequestLimiter();
  const retrieval = createLocalHostMemoryRetrieval({ ...options, requestLimiter: limit });
  const retrievalConfigured = async () => {
    const current = await retrieval.settings.get();
    return current.enabled && current.providerId !== undefined && current.modelId !== undefined;
  };
  const attentionConfigured = async () =>
    (await settings.get()).secretRef !== undefined || (await retrievalConfigured());
  const tasks = new Map<string, { version: number; digest: string; goal: string }>();
  const states = createFileMemoryAttentionStateStore(options);
  const missions = new Map<string, MissionBinding>();
  const contexts = new Map<string, { context: ExpertAgentRunContext; missionId: string }>();
  const watches = new Map<
    string,
    { missionId: string; subscription: ExecutionEventSubscription; done: Promise<void> }
  >();
  const observedTools = new Set<string>();
  let closed = false;
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
        /\b(?:api[_-]?key|password|secret|token)["']?\s*[:=]\s*["']?[^\s"',;}]+/gi,
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
    ref: {
      module: "episodic" | "semantic";
      memoryId: string;
      selectedPaths?: import("@pragma/memory").MemoryAttentionEntry["selectedPaths"] | undefined;
    },
  ): Promise<MemoryAttentionCandidate | undefined> => {
    if (ref.module === "episodic") {
      const record = await options.data.episodic.store.peekForRecall(scope, ref.memoryId);
      if (record === undefined || record.sensitivity === "restricted") return undefined;
      if (
        (ref.selectedPaths ?? []).some((path) => {
          const text = selectedMemoryText(
            { module: "episodic", record },
            path.fieldPath,
            path.start,
            path.end,
          );
          return (
            text === undefined || createHash("sha256").update(text).digest("hex") !== path.textHash
          );
        })
      )
        return undefined;
      return {
        ...ref,
        revision: record.revision,
        title: redact(record.goal.text, 180),
        summary: redactMemoryProjection(
          (ref.selectedPaths ?? [])
            .map(
              (path) =>
                selectedMemoryText(
                  { module: "episodic", record },
                  path.fieldPath,
                  path.start,
                  path.end,
                ) ?? "",
            )
            .join("\n") ||
            `Goal: ${record.goal.text}\nSummary: ${record.summary.text}\nOutcome: ${record.outcome.summary}`,
        ),
        selectedPaths: ref.selectedPaths,
        relations: (
          await options.data.episodic.store.relatedForRecall(scope, ref.memoryId, 12)
        ).map((value) => ({ module: "episodic" as const, memoryId: value.id })),
      };
    }
    const record = await options.data.semantic.store.peekForRecall(scope, ref.memoryId, new Date());
    if (record === undefined || record.sensitivity === "restricted") return undefined;
    if (
      (ref.selectedPaths ?? []).some((path) => {
        const text = selectedMemoryText(
          { module: "semantic", record },
          path.fieldPath,
          path.start,
          path.end,
        );
        return (
          text === undefined || createHash("sha256").update(text).digest("hex") !== path.textHash
        );
      })
    )
      return undefined;
    const conflictsWith: string[] = [];
    for (const id of record.conflictsWith)
      if (await options.data.semantic.store.peekForRecall(scope, id, new Date()))
        conflictsWith.push(id);
    return {
      ...ref,
      revision: record.revision,
      title: redact(record.statement, 180),
      summary: redactMemoryProjection(renderSemanticFact({ ...record, conflictsWith })),
      selectedPaths: ref.selectedPaths,
      relations: conflictsWith.map((memoryId) => ({
        module: "semantic" as const,
        memoryId,
      })),
    };
  };
  const decisionCache = new BoundedLruCache<string, { expiresAt: number; value: unknown }>(64);
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
    const cached = async <T>(
      method: string,
      input: unknown,
      signal: AbortSignal,
      run: () => Promise<T>,
    ): Promise<T> => {
      signal.throwIfAborted();
      const key = createHash("sha256")
        .update(JSON.stringify([snapshot.revision, method, input]))
        .digest("hex");
      const prior = decisionCache.get(key);
      if (prior !== undefined && prior.expiresAt > Date.now()) return prior.value as T;
      const value = await limit(signal, run);
      signal.throwIfAborted();
      decisionCache.set(key, { expiresAt: Date.now() + 60_000, value });
      return value;
    };
    return {
      chooseExpansion: async (...args: Parameters<NonNullable<typeof provider.chooseExpansion>>) =>
        await cached("choice", args[0], args[1], () => provider.chooseExpansion!(...args)),
      assessRecall: async (...args: Parameters<typeof provider.assessRecall>) =>
        await cached("recall", args[0], args[1], () => provider.assessRecall(...args)),
      assessCandidates: async (...args: Parameters<typeof provider.assessCandidates>) =>
        await cached("candidates", args[0], args[1], () => provider.assessCandidates(...args)),
      assessAttention: async (...args: Parameters<typeof provider.assessAttention>) =>
        await cached("attention", args[0], args[1], () => provider.assessAttention(...args)),
    };
  };
  const controller = createMemoryAttentionController({
    store: states,
    getBinding: async () => {
      if (closed || (await options.data.policies.getGlobal()).policy.enabled !== "enabled")
        return undefined;
      const current = await settings.get();
      if (current.secretRef === undefined && !(await retrievalConfigured())) return undefined;
      return {
        generation: createHash("sha256")
          .update(`${current.revision}:${await retrieval.bindingRevision()}`)
          .digest()
          .readUIntBE(0, 6),
        providerRevision: current.revision,
        provider:
          current.secretRef === undefined ||
          current.diagnostic?.permanent ||
          (current.diagnostic?.retryAt ?? 0) > Date.now()
            ? undefined
            : providerFor(current),
        available: true,
      };
    },
    read: candidate,
    detail: async (scope, ref) => {
      const base = await candidate(scope, ref);
      if (base === undefined) return undefined;
      const source =
        ref.module === "episodic"
          ? await options.data.episodic.store
              .peekForRecall(scope, ref.memoryId)
              .then((record) =>
                record === undefined ? undefined : { module: "episodic" as const, record },
              )
          : await options.data.semantic.store
              .peekForRecall(scope, ref.memoryId)
              .then((record) =>
                record === undefined ? undefined : { module: "semantic" as const, record },
              );
      if (source === undefined || source.record.revision !== base.revision) return undefined;
      const segments = memoryDetailSegments(source, base.selectedPaths);
      return {
        ...base,
        summary:
          source.module === "semantic"
            ? base.summary
            : segments.map((segment) => segment.text).join("\n"),
        selectedPaths: segments.map(({ fieldPath, start, end, textHash }) => ({
          fieldPath,
          start,
          end,
          textHash,
        })),
      };
    },
    search: async (scope, queries, modules, signal) => {
      const result: MemoryAttentionCandidate[] = [];
      for (const query of queries)
        for (const module of modules) {
          const records =
            module === "episodic"
              ? await options.data.episodic.store.searchCandidatesForRecall(scope, query, 8)
              : await options.data.semantic.store.searchCandidatesForRecall(
                  scope,
                  query,
                  8,
                  new Date(),
                );
          for (const record of records) {
            const value = await candidate(scope, { module, memoryId: record.id });
            if (
              value !== undefined &&
              !result.some((item) => item.module === module && item.memoryId === value.memoryId)
            )
              result.push(value);
          }
        }
      const vectors = await retrieval.candidates(
        scope,
        queries.join("\n"),
        modules,
        30,
        signal === undefined
          ? AbortSignal.timeout(3_000)
          : AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
      );
      const textRanks = new Map(result.map((item, i) => [`${item.module}:${item.memoryId}`, i]));
      const vectorRanks = new Map(vectors.map((item, i) => [`${item.module}:${item.memoryId}`, i]));
      const fused = new Map(
        [...result, ...vectors].map((item) => [`${item.module}:${item.memoryId}`, item]),
      );
      const score = (key: string) =>
        (textRanks.has(key) ? 1 / (60 + textRanks.get(key)! + 1) : 0) +
        (vectorRanks.has(key) ? 1 / (60 + vectorRanks.get(key)! + 1) : 0);
      const ranked = [...fused]
        .toSorted(([a], [b]) => score(b) - score(a) || a.localeCompare(b))
        .slice(0, 30)
        .map(([, value]) => value);
      if (modules.length < 2) return ranked;
      const balanced = ranked.filter(
        (item, index) =>
          ranked.slice(0, index).filter((other) => other.module === item.module).length < 15,
      );
      return balanced;
    },
    isCurrent: async (input, scope) => {
      const tracked = contexts.get(input.contextId);
      if (
        closed ||
        tracked?.missionId !== input.missionId ||
        !missions.has(input.missionId) ||
        (input.taskVersion !== undefined &&
          tasks.get(input.contextId)?.version !== input.taskVersion)
      )
        return false;
      const current = await resolveScope(tracked.context);
      return (
        (await attentionConfigured()) &&
        current !== undefined &&
        memoryAttentionScopeDigest(current) === memoryAttentionScopeDigest(scope)
      );
    },
    onDiagnostic: async (code, generation) => {
      try {
        if (code !== "attention_provider_unconfigured")
          await settings.recordDiagnostic(code, generation);
        else code = undefined;
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
    if ((current.secretRef === undefined && !(await retrievalConfigured())) || !alive(binding))
      return;
    // Register the configured credential before constructing even the first delta.
    if (current.secretRef !== undefined && redactedGeneration !== current.revision) {
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
    const prior = tasks.get(run.contextId);
    const goal =
      action === "task_started"
        ? redact(observation, 800)
        : action === "user_clarification"
          ? redact(`${prior?.goal ?? binding.goal}\nUser clarification: ${text}`, 800)
          : (prior?.goal ?? redact(binding.goal, 800));
    const digest = JSON.stringify({ goal, text, action });
    const task =
      prior?.digest === digest ? prior : { version: (prior?.version ?? 0) + 1, digest, goal };
    tasks.set(run.contextId, task);
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
        missionGoal: redact(binding.goal, 800),
        currentGoal: goal,
        taskVersion: task.version,
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
    if (event.type === "invocation.started") {
      const invocation = await options.data.executionStore.getInvocation(
        event.executionId,
        event.invocationId,
      );
      const prompt = ExpertPromptInputSchema.safeParse(invocation?.input);
      const goal = prompt.success
        ? prompt.data.text
        : typeof invocation?.input === "string"
          ? invocation.input
          : undefined;
      if (goal !== undefined)
        await observe(binding, await eventContext(event), goal, "task_started", "goal_changed");
    } else if (event.type === "runtime.event") {
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
    } else if (event.type === "human.responded") {
      const response =
        typeof event.data === "object" && event.data !== null && "response" in event.data
          ? event.data.response
          : undefined;
      if (
        typeof response === "object" &&
        response !== null &&
        "kind" in response &&
        response.kind === "user_question" &&
        "answers" in response
      )
        await observe(
          binding,
          await eventContext(event),
          response.answers,
          "user_clarification",
          "goal_changed",
        );
    } else if (event.type === "context.compacted") {
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
    retrieval: {
      ...retrieval,
      settings: {
        ...retrieval.settings,
        update: async (input: Parameters<typeof retrieval.settings.update>[0]) => {
          const next = await retrieval.settings.update(input);
          controller.cancelPending();
          return next;
        },
      },
    },
    states,
    async missionAttention(missionId: string) {
      const paths = new PragmaPaths(options);
      let names: string[];
      try {
        names = await readdir(paths.memoryAttentionRoot(missionId));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
      const values = [];
      for (const name of names
        .filter((name) => name.endsWith(".json") && !name.endsWith(".state-migration.json"))
        .slice(0, 128)) {
        const contextId = decodePragmaPathSegment(name.slice(0, -5));
        const state = await states.read(missionId, contextId);
        if (state !== undefined)
          values.push({
            contextId,
            version: state.version,
            entries: (
              await Promise.all(
                state.active.map(async (entry) => {
                  const source =
                    entry.module === "episodic"
                      ? await options.data.episodic.store.get(entry.memoryId)
                      : await options.data.semantic.store.get(entry.memoryId);
                  return source?.status === "active" &&
                    source.revision === entry.revision &&
                    source.sensitivity !== "restricted"
                    ? entry
                    : undefined;
                }),
              )
            )
              .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
              .map(({ module, memoryId, revision, decisionMode, selectedPaths }) => ({
                module,
                memoryId,
                revision,
                decisionMode,
                selectedPaths,
              })),
            ...(state.audit.at(-1)?.code === undefined ||
            state.audit.at(-1)?.code === "attention_provider_unconfigured"
              ? {}
              : { errorCode: state.audit.at(-1)!.code }),
          });
      }
      return values;
    },
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
        vectorSearch: async (scope, input) => {
          if (input.scope === "path") return [];
          const matches = await retrieval.search(scope, input.query, input.maxResults ?? 20);
          const current = await resolveScope(input.context, binding);
          if (
            current === undefined ||
            memoryAttentionScopeDigest(current) !== memoryAttentionScopeDigest(scope)
          )
            return [];
          return matches;
        },
        resolveRecallScope: async (context) =>
          inMission(
            binding,
            async () => {
              const scope = await resolveScope(context, binding);
              try {
                if (scope !== undefined && (await attentionConfigured()) && alive(binding))
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
        if (tracked.missionId === missionId) {
          contexts.delete(id);
          tasks.delete(id);
        }
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
      tasks.clear();
      await controller.stop();
      await retrieval.stop();
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
