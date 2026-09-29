import { createHash } from "node:crypto";
import {
  error,
  StaticContextStore,
  defaultRuntimeTokenCounter,
  type ExpertAgentContextStore,
} from "@pragma/core";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";
import { escapeMarkdownLinkLabel } from "../context/markdown.ts";
import {
  MemoryAttentionInputSchema,
  RecallDecisionSchema,
  CandidateDecisionSchema,
  attentionCandidateKey,
  type MemoryAttentionInput,
  type MemoryAttentionCandidate,
  type MemoryDecisionProvider,
} from "./decision-provider.ts";
import {
  MEMORY_ATTENTION_POLICY as policy,
  MEMORY_ATTENTION_VERSION,
  MEMORY_ATTENTION_CONTEXT_ID,
  MEMORY_ATTENTION_HINT,
  type MemoryAttentionEntry,
  type MemoryAttentionState,
  type MemoryAttentionStateStore,
} from "./state.ts";

export interface MemoryAttentionBinding {
  readonly generation: number;
  readonly providerRevision?: number;
  readonly provider: MemoryDecisionProvider | undefined;
  readonly available?: boolean;
}
export interface MemoryAttentionController {
  observe(input: MemoryAttentionInput, scope: MemoryRecallScope): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
  cancelPending(): void;
  cancelMission(missionId: string): Promise<void>;
  getState(missionId: string, contextId: string): Promise<MemoryAttentionState | undefined>;
  createContextView(input: {
    missionId: string;
    contextId: string;
    scope: MemoryRecallScope;
  }): Promise<ExpertAgentContextStore | undefined>;
  consumeHint(input: {
    missionId: string;
    contextId: string;
    scope: MemoryRecallScope;
  }): Promise<string | undefined>;
}

export function createMemoryAttentionController(options: {
  readonly store: MemoryAttentionStateStore;
  readonly getBinding: () => Promise<MemoryAttentionBinding | undefined>;
  readonly search: (
    scope: MemoryRecallScope,
    queries: readonly string[],
    modules: readonly ("episodic" | "semantic")[],
    signal?: AbortSignal,
  ) => Promise<readonly MemoryAttentionCandidate[]>;
  readonly read: (
    scope: MemoryRecallScope,
    entry: Pick<MemoryAttentionEntry, "module" | "memoryId"> & {
      selectedPaths?: MemoryAttentionEntry["selectedPaths"] | undefined;
    },
  ) => Promise<MemoryAttentionCandidate | undefined>;
  readonly detail?: (
    scope: MemoryRecallScope,
    candidate: MemoryAttentionCandidate,
  ) => Promise<MemoryAttentionCandidate | undefined>;
  readonly isCurrent: (input: MemoryAttentionInput, scope: MemoryRecallScope) => Promise<boolean>;
  readonly onDiagnostic: (code: string | undefined, generation: number) => Promise<void>;
  readonly now?: () => Date;
}): MemoryAttentionController {
  const now = options.now ?? (() => new Date());
  let stopped = false;
  const running = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  const pending = new Map<string, { input: MemoryAttentionInput; scope: MemoryRecallScope }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastEvaluated = new Map<string, number>();

  const fresh = (
    input: MemoryAttentionInput,
    scope: MemoryRecallScope,
    generation: number,
  ): MemoryAttentionState => ({
    schemaVersion: MEMORY_ATTENTION_VERSION,
    taskVersion: input.taskVersion,
    missionId: input.missionId,
    contextId: input.contextId,
    scopeDigest: memoryAttentionScopeDigest(scope),
    generation,
    version: 0,
    revision: 0,
    active: [],
    lastHintedVersion: 0,
    lastReadVersion: 0,
    audit: [],
  });
  const sameBinding = async (
    generation: number,
    input: MemoryAttentionInput,
    scope: MemoryRecallScope,
  ) =>
    !stopped &&
    (await options.getBinding())?.generation === generation &&
    (await options.isCurrent(input, scope));

  const assess = async (
    input: MemoryAttentionInput,
    scope: MemoryRecallScope,
    signal: AbortSignal,
  ): Promise<void> => {
    const binding = await options.getBinding();
    if (
      binding === undefined ||
      binding.available === false ||
      !(await options.isCurrent(input, scope))
    )
      return;
    const digest = attentionDigest({
      goal: input.currentGoal ?? input.missionGoal,
      taskVersion: input.taskVersion,
      observation: input.latestObservation,
      action: input.lastAction,
      concepts: input.concepts,
      trigger: input.trigger,
    });
    const stored = await options.store.read(input.missionId, input.contextId);
    const state =
      stored?.scopeDigest === memoryAttentionScopeDigest(scope) &&
      stored.generation === binding.generation
        ? stored
        : fresh(input, scope, binding.generation);
    if (state.lastDeltaDigest === digest) return;
    const guard = async (candidates: readonly MemoryAttentionCandidate[] = []) => {
      signal.throwIfAborted();
      if (!(await sameBinding(binding.generation, input, scope))) {
        throw new Error("attention_cancelled");
      }
      for (const expected of candidates) {
        const current = await options.read(scope, expected);
        if (current?.revision !== expected.revision) throw new Error("attention_cancelled");
      }
      signal.throwIfAborted();
    };
    const timestamp = now().toISOString();
    let next: MemoryAttentionEntry[] = [];
    let significant = false;
    let code: string | undefined;
    let outcome: "updated" | "unchanged" | "skipped" | "failed" = "skipped";
    try {
      if (binding.provider === undefined) throw new Error("attention_provider_unconfigured");
      const decision = RecallDecisionSchema.parse(
        await binding.provider.assessRecall(input, signal, guard),
      );
      await guard();
      // Revalidate existing references before any summary is sent to the provider.
      const existing = (
        await Promise.all(state.active.map((entry) => options.read(scope, entry)))
      ).filter((value): value is MemoryAttentionCandidate => value !== undefined);
      let assessedCandidates = existing;
      const validKeys = new Set(existing.map(attentionCandidateKey));
      next = state.active.filter(
        (entry) =>
          validKeys.has(attentionCandidateKey(entry)) &&
          entry.relevance *
            2 ** (-(now().getTime() - Date.parse(entry.lastRelevantAt)) / policy.halfLifeMs) >=
            policy.evictionThreshold,
      );
      if (decision.recall >= policy.recallThreshold) {
        const modules: ("episodic" | "semantic")[] = [];
        if (decision.episodic >= policy.recallThreshold) modules.push("episodic");
        if (decision.semantic >= policy.recallThreshold) modules.push("semantic");
        const queries = [
          input.currentGoal ?? input.missionGoal,
          input.latestObservation,
          ...input.concepts,
        ]
          .filter(Boolean)
          .slice(0, policy.maxQueries);
        const found =
          modules.length === 0 || queries.length === 0
            ? []
            : await options.search(scope, queries, modules, signal);
        let candidates = [
          ...new Map(
            [...existing, ...found.slice(0, policy.maxCandidates)].map((candidate) => [
              attentionCandidateKey(candidate),
              candidate,
            ]),
          ).values(),
        ];
        candidates = candidates.slice(0, policy.maxCandidates);
        assessedCandidates = candidates;
        await guard(candidates);
        const visited = new Set(candidates.map(attentionCandidateKey));
        const actionsUsed = new Set<string>();
        let detailReads = 0;
        for (let round = 0; round < policy.maxRounds; round++) {
          const snapshot = structuredClone(candidates);
          const candidateSetDigest = attentionDigest(snapshot);
          const response = await binding.provider.assessCandidates(
            { delta: input, candidates: snapshot, active: next },
            signal,
            () => guard(snapshot),
          );
          // Bind the entire response to this round, including source revisions.
          // Recheck after the final batch before selecting or expanding anything.
          await guard(snapshot);
          if (
            attentionDigest(snapshot) !== candidateSetDigest ||
            attentionDigest(candidates) !== candidateSetDigest
          )
            throw new Error("attention_response_invalid");
          const assessments = CandidateDecisionSchema.safeParse(response);
          const expectedKeys = new Set(snapshot.map(attentionCandidateKey));
          if (
            !assessments.success ||
            expectedKeys.size !== snapshot.length ||
            assessments.data.length !== expectedKeys.size ||
            assessments.data.some((value) => !expectedKeys.has(value.key))
          )
            throw new Error("attention_response_invalid");
          const values = new Map(assessments.data.map((value) => [value.key, value]));
          for (const candidate of candidates) {
            const key = attentionCandidateKey(candidate);
            const value = values.get(key)!;
            const old = next.find((entry) => attentionCandidateKey(entry) === key);
            if (old !== undefined && value.relevance < policy.relevanceThreshold) {
              next = next.filter((entry) => attentionCandidateKey(entry) !== key);
              if (value.relevance >= policy.evictionThreshold) {
                next.push({ ...old, relevance: value.relevance });
              }
              continue;
            }
            if (
              value.relevance < policy.relevanceThreshold ||
              (old === undefined && value.novelty < policy.recallThreshold)
            )
              continue;
            next = next.filter((entry) => attentionCandidateKey(entry) !== key);
            next.push({
              module: candidate.module,
              memoryId: candidate.memoryId,
              revision: candidate.revision,
              relevance: value.relevance,
              decisionMode: "provider",
              pinned: false,
              selectedPaths: candidate.selectedPaths ?? [],
              ...(candidate.similarity === undefined ? {} : { similarity: candidate.similarity }),
              ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
              reason: old?.reason ?? input.trigger,
              firstActivatedAt: old?.firstActivatedAt ?? timestamp,
              lastRelevantAt: timestamp,
            });
          }
          if (binding.provider.chooseExpansion === undefined || round + 1 >= policy.maxRounds)
            break;
          const actions = candidates.flatMap((candidate) => {
            const key = attentionCandidateKey(candidate);
            return [
              { id: `detail_${key}`, kind: "detail" as const, candidateKey: key },
              { id: `expand_${key}`, kind: "expand" as const, candidateKey: key },
            ].filter((action) => !actionsUsed.has(action.id));
          });
          const selected = await binding.provider.chooseExpansion(
            { delta: input, candidates, actions },
            signal,
            () => guard(candidates),
          );
          await guard(candidates);
          if (selected === undefined) break;
          const action = actions.find((action) => action.id === selected);
          if (action === undefined) throw new Error("attention_response_invalid");
          actionsUsed.add(selected);
          const chosen = candidates.find(
            (candidate) => attentionCandidateKey(candidate) === action.candidateKey,
          )!;
          if (action.kind === "detail") {
            if (++detailReads > policy.maxDetails || options.detail === undefined) break;
            const detailed = await options.detail(scope, chosen);
            if (detailed === undefined || detailed.revision !== chosen.revision)
              throw new Error("attention_cancelled");
            candidates = [detailed];
            assessedCandidates = [
              ...assessedCandidates.filter(
                (candidate) => attentionCandidateKey(candidate) !== action.candidateKey,
              ),
              detailed,
            ];
          } else {
            const refs = (chosen.relations ?? []).slice(
              0,
              Math.max(0, policy.maxDetails - detailReads),
            );
            detailReads += refs.length;
            const relations = await Promise.all(refs.map((ref) => options.read(scope, ref)));
            const related = relations.filter(
              (value): value is MemoryAttentionCandidate => value !== undefined,
            );
            const expanded = await options.search(scope, [chosen.summary], [chosen.module], signal);
            candidates = [
              ...new Map(
                [...related, ...expanded].map((candidate) => [
                  attentionCandidateKey(candidate),
                  candidate,
                ]),
              ).values(),
            ]
              .filter((candidate) => !visited.has(attentionCandidateKey(candidate)))
              .slice(0, Math.max(0, policy.maxCandidates - visited.size));
            for (const candidate of candidates) visited.add(attentionCandidateKey(candidate));
            assessedCandidates = [...assessedCandidates, ...candidates];
            if (candidates.length === 0) break;
          }
          await guard(candidates);
        }
      }
      const rank = (entry: MemoryAttentionEntry) =>
        Math.round(
          entry.relevance *
            2 **
              (-Math.max(0, now().getTime() - Date.parse(entry.lastRelevantAt)) /
                policy.halfLifeMs) *
            10,
        );
      next = next
        .toSorted(
          (a, b) =>
            rank(b) - rank(a) || attentionCandidateKey(a).localeCompare(attentionCandidateKey(b)),
        )
        .slice(0, policy.maxItems);
      const changed =
        attentionDigest(visibleEntries(state.active)) !== attentionDigest(visibleEntries(next));
      if (changed) {
        await guard(assessedCandidates);
        significant = await binding.provider.assessAttention(
          { delta: input, previous: state.active, next, candidates: assessedCandidates },
          signal,
          () => guard(assessedCandidates),
        );
      }
      outcome = changed ? "updated" : "unchanged";
    } catch (error) {
      if (
        signal.aborted ||
        stopped ||
        (error instanceof Error && error.message === "attention_cancelled")
      )
        return;
      code = error instanceof Error ? error.message : "attention_assessment_failed";
      // Unknown errors are not copied to persistent diagnostics.
      if (!/^attention_[a-z_]+$/.test(code)) code = "attention_assessment_failed";
      next = state.active;
      // Conservative fallback uses calibrated engineering similarity, never a probability of relevance.
      try {
        const found = await options.search(
          scope,
          [input.currentGoal ?? input.missionGoal, input.latestObservation].filter(Boolean),
          ["episodic", "semantic"],
          signal,
        );
        await guard(found);
        const unassessed = found
          .filter((candidate) => (candidate.similarity ?? -1) >= 0.8)
          .slice(0, 3);
        if (unassessed.length > 0)
          next = state.active.filter((entry) => entry.decisionMode === "provider").slice(0, 5);
        for (const candidate of unassessed)
          if (
            !next.some((entry) => attentionCandidateKey(entry) === attentionCandidateKey(candidate))
          )
            next = [
              ...next,
              {
                module: candidate.module,
                memoryId: candidate.memoryId,
                revision: candidate.revision,
                relevance: 0.7,
                decisionMode: "vector_unassessed",
                similarity: candidate.similarity,
                pinned: false,
                selectedPaths: candidate.selectedPaths ?? [],
                reason: input.trigger,
                firstActivatedAt: timestamp,
                lastRelevantAt: timestamp,
              },
            ];
        next = next.slice(0, policy.maxItems);
      } catch {
        /* Preserve previous validated attention when the fallback is unavailable. */
      }
      outcome = "failed";
    }
    if (signal.aborted || !(await sameBinding(binding.generation, input, scope))) return;
    // Recheck visibility after the network round trip, including forget and revision changes.
    const readable = await Promise.all(
      next.map(async (entry) => {
        const candidate = await options.read(scope, entry);
        return candidate !== undefined && candidate.revision === entry.revision ? entry : undefined;
      }),
    );
    next = readable.filter((entry): entry is MemoryAttentionEntry => entry !== undefined);
    if (signal.aborted || !(await sameBinding(binding.generation, input, scope))) return;
    await options.store.update(input.missionId, input.contextId, (current) => {
      // Acknowledgements do not change decision inputs. Only another content
      // update invalidates this result; merge the latest read/hint cursors below.
      if (attentionContentDigest(current) !== attentionContentDigest(stored)) return undefined;
      const acknowledged =
        current?.generation === state.generation && current.scopeDigest === state.scopeDigest
          ? current
          : state;
      const changed =
        attentionDigest(visibleEntries(state.active)) !== attentionDigest(visibleEntries(next));
      return {
        ...state,
        taskVersion: input.taskVersion,
        revision: (current?.revision ?? 0) + 1,
        version: state.version + (changed ? 1 : 0),
        active: next,
        lastDeltaDigest: outcome === "failed" ? state.lastDeltaDigest : digest,
        // Non-significant updates are visible when read but do not generate a hint.
        lastReadVersion: acknowledged.lastReadVersion,
        lastHintedVersion:
          changed && !significant ? state.version + 1 : acknowledged.lastHintedVersion,
        audit: [
          ...state.audit.filter(
            (entry) => Date.parse(entry.occurredAt) >= now().getTime() - policy.auditRetentionMs,
          ),
          {
            occurredAt: timestamp,
            deltaDigest: digest,
            result: outcome,
            ...(code === undefined ? {} : { code }),
            refs: next.map(attentionCandidateKey),
          },
        ].slice(-policy.auditMaxEntries),
      };
    });
    await options.onDiagnostic(code, binding.providerRevision ?? binding.generation);
  };
  const start = (key: string): void => {
    if (stopped || running.has(key)) return;
    const value = pending.get(key);
    if (value === undefined) return;
    pending.delete(key);
    lastEvaluated.set(key, now().getTime());
    // Limit idle bookkeeping, rather than retaining every Context ever observed.
    if (lastEvaluated.size > 128) {
      for (const idle of lastEvaluated.keys()) {
        if (!running.has(idle) && idle !== key) {
          lastEvaluated.delete(idle);
          break;
        }
      }
    }
    const abort = new AbortController();
    const promise = assess(
      value.input,
      value.scope,
      AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
    )
      .catch(async () => {
        try {
          const binding = await options.getBinding();
          if (binding !== undefined)
            await options.onDiagnostic(
              "attention_state_unavailable",
              binding.providerRevision ?? binding.generation,
            );
        } catch {
          // An unavailable settings store must not reject a detached background task.
        }
      })
      .finally(() => {
        running.delete(key);
        if (pending.has(key)) schedule(key);
      });
    running.set(key, { abort, promise });
  };
  const schedule = (key: string): void => {
    if (timers.has(key) || running.has(key) || stopped) return;
    const delay = Math.max(
      policy.debounceMs,
      (lastEvaluated.get(key) ?? 0) + policy.minIntervalMs - now().getTime(),
    );
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        start(key);
      }, delay),
    );
  };
  const getVisible = async (input: {
    missionId: string;
    contextId: string;
    scope: MemoryRecallScope;
  }) => {
    const binding = await options.getBinding();
    if (
      binding === undefined ||
      stopped ||
      !(await options.isCurrent(
        {
          missionId: input.missionId,
          contextId: input.contextId,
          missionGoal: "",
          latestObservation: "",
          lastAction: "",
          trigger: "new_observation",
          concepts: [],
        },
        input.scope,
      ))
    )
      return undefined;
    const state = await options.store.read(input.missionId, input.contextId);
    if (
      state === undefined ||
      state.generation !== binding.generation ||
      state.scopeDigest !== memoryAttentionScopeDigest(input.scope)
    )
      return undefined;
    const candidates = await Promise.all(
      state.active.map(async (entry) => {
        const candidate = await options.read(input.scope, entry);
        return candidate === undefined || candidate.revision !== entry.revision
          ? undefined
          : { entry, candidate };
      }),
    );
    if (
      !(await sameBinding(
        binding.generation,
        {
          missionId: input.missionId,
          contextId: input.contextId,
          missionGoal: "",
          latestObservation: "",
          lastAction: "",
          trigger: "new_observation",
          concepts: [],
          taskVersion: state.taskVersion,
        },
        input.scope,
      ))
    )
      return undefined;
    return {
      state,
      candidates: candidates.filter(
        (value): value is NonNullable<typeof value> => value !== undefined,
      ),
    };
  };
  return {
    cancelPending() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
      for (const value of running.values()) value.abort.abort();
    },
    async cancelMission(missionId) {
      const prefix = `${missionId}\0`;
      for (const [key, timer] of timers)
        if (key.startsWith(prefix)) {
          clearTimeout(timer);
          timers.delete(key);
        }
      for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
      const active = [...running].filter(([key]) => key.startsWith(prefix));
      for (const [, value] of active) value.abort.abort();
      await Promise.all(active.map(([, value]) => value.promise));
      for (const key of lastEvaluated.keys()) if (key.startsWith(prefix)) lastEvaluated.delete(key);
    },
    observe(raw, scope) {
      if (stopped) return;
      const input = MemoryAttentionInputSchema.parse(raw);
      if (Buffer.byteLength(JSON.stringify(input)) > policy.maxDeltaBytes) return;
      const key = `${input.missionId}\0${input.contextId}`;
      if (!pending.has(key) && pending.size >= 128) return;
      const previous = pending.get(key);
      // A routine observation may advance taskVersion without resolving a
      // failure. Keep that failure, but assess it against the latest task version.
      const preserveFailure =
        previous?.input.trigger === "new_error" &&
        input.trigger === "new_observation" &&
        input.currentGoal === previous.input.currentGoal &&
        input.missionGoal === previous.input.missionGoal &&
        JSON.stringify(scope) === JSON.stringify(previous.scope);
      pending.set(key, {
        input: preserveFailure
          ? {
              ...input,
              trigger: "new_error",
              latestObservation: previous.input.latestObservation,
              concepts: previous.input.concepts,
            }
          : input,
        scope,
      });
      schedule(key);
    },
    getState: (missionId, contextId) => options.store.read(missionId, contextId),
    async flush() {
      while (pending.size > 0 || running.size > 0) {
        for (const [key, timer] of timers) {
          clearTimeout(timer);
          timers.delete(key);
          start(key);
        }
        await Promise.all([...running.values()].map((value) => value.promise));
      }
    },
    async stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      pending.clear();
      for (const value of running.values()) value.abort.abort();
      await Promise.all([...running.values()].map((value) => value.promise));
    },
    async createContextView(input) {
      const binding = await options.getBinding();
      if (binding === undefined) return undefined;
      const render = async () => {
        const visible = await getVisible(input);
        const store = new StaticContextStore([
          {
            id: MEMORY_ATTENTION_CONTEXT_ID,
            content: trimLens(
              `# Mission Memory Attention\n\nVersion: ${visible?.state.version ?? 0}\n`,
              visible?.candidates.map(({ entry, candidate }) => ({
                source: `- [${escapeMarkdownLinkLabel(candidate.title)}](${entry.module}/items/${entry.memoryId}.md)\n  reason: ${reasonLabel(entry.reason)}; assessment: ${entry.decisionMode}\n`,
                summary: candidate.summary,
              })) ?? [],
              policy.maxLensBytes,
            ),
            metadata: {
              trigger: "manual",
              priority: "normal",
              trustLevel: "system",
              sensitivity: "internal",
              description: "Mission-specific historical context, available on demand.",
            },
          },
        ]);
        return { visible, store };
      };
      return {
        listContext: async (value) => (await render()).store.listContext(value),
        searchContext: async (value) => (await render()).store.searchContext(value),
        addContext: async () => error("permission_denied", "Memory Attention is read-only."),
        editContext: async () => error("permission_denied", "Memory Attention is read-only."),
        deleteContext: async () => error("permission_denied", "Memory Attention is read-only."),
        async readContext(value) {
          const { store, visible } = await render();
          const result = await store.readContext(value);
          if (result.ok && visible !== undefined)
            await options.store.update(input.missionId, input.contextId, (current) => {
              if (
                current === undefined ||
                current.revision !== visible.state.revision ||
                current.generation !== visible.state.generation ||
                current.scopeDigest !== visible.state.scopeDigest
              )
                return undefined;
              return {
                ...current,
                revision: current.revision + 1,
                lastReadVersion: current.version,
              };
            });
          return result;
        },
      };
    },
    async consumeHint(input) {
      const visible = await getVisible(input);
      if (visible === undefined || visible.candidates.length === 0) return undefined;
      let consumed = false;
      await options.store.update(input.missionId, input.contextId, (current) => {
        if (
          current === undefined ||
          current.revision !== visible.state.revision ||
          current.generation !== visible.state.generation ||
          current.scopeDigest !== visible.state.scopeDigest ||
          current.version <= Math.max(current.lastHintedVersion, current.lastReadVersion)
        )
          return undefined;
        consumed = true;
        return { ...current, revision: current.revision + 1, lastHintedVersion: current.version };
      });
      return consumed ? MEMORY_ATTENTION_HINT : undefined;
    },
  };
}
export function memoryAttentionScopeDigest(scope: MemoryRecallScope): string {
  return attentionDigest({
    rootRef: scope.rootRef,
    expertRef: scope.expertRef,
    principalRefs: [...(scope.principalRefs ?? [])].toSorted((a, b) =>
      `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`),
    ),
  });
}
export function attentionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function visibleEntries(entries: readonly MemoryAttentionEntry[]) {
  return entries.map(({ module, memoryId, revision, reason, decisionMode, selectedPaths }) => ({
    module,
    memoryId,
    revision,
    reason,
    decisionMode,
    selectedPaths,
  }));
}
function reasonLabel(reason: MemoryAttentionEntry["reason"]): string {
  return {
    new_error: "Relevant to a newly observed error",
    new_observation: "Relevant to new task evidence",
    goal_changed: "Relevant to the current goal",
    historical_precedent: "Related historical precedent",
  }[reason];
}

function attentionContentDigest(state: MemoryAttentionState | undefined): string {
  if (state === undefined) return attentionDigest(null);
  const { revision, lastReadVersion, lastHintedVersion, ...content } = state;
  void revision;
  void lastReadVersion;
  void lastHintedVersion;
  return attentionDigest(content);
}

function trimLens(
  header: string,
  items: readonly { source: string; summary: string }[],
  maxBytes: number,
): string {
  let value = header;
  const fits = (text: string) =>
    Buffer.byteLength(text) <= maxBytes &&
    defaultRuntimeTokenCounter.countText(text).tokens <= policy.maxLensTokens;
  for (const item of items) {
    const prefix = `${value}\n${item.source}`;
    if (!fits(prefix)) break;
    const candidate = `${prefix}${item.summary}`;
    if (fits(candidate)) {
      value = candidate;
      continue;
    }
    // Consume the remaining budget in rank order without splitting Unicode.
    const points = Array.from(item.summary);
    const suffix = "\n[truncated; read source for full details]";
    if (!fits(prefix + suffix)) break;
    let lo = 0;
    let hi = points.length;
    let end = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(prefix + points.slice(0, mid).join("") + suffix)) {
        end = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    value = prefix + points.slice(0, end).join("") + suffix;
    break;
  }
  return value;
}
