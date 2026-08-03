import {
  EXECUTION_CURRENT_EXPERT_ID_ATTR,
  readExecutionRunScope,
  createFileCanonicalEventFeed,
  createFileExecutionStore,
  type FileExecutionStore,
  type ExpertAgentRunContext,
  type PragmaLogger,
} from "@pragma/core";
import {
  MemoryModuleRegistry,
  createEpisodicMemoryModule,
  createSemanticMemoryModule,
  createFileMemoryExtractorProfileStore,
  createExecutionEvidenceAdapter,
  createFederatedMemoryContextStore,
  createFileMemoryPolicyStore,
  createFileMemoryPipelineStateStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  createMemoryActivityStore,
  MemoryRecallScopeSchema,
  type MemoryPolicyStore,
  type MemoryRecallScope,
  type EpisodicMemoryExtractor,
  type MemoryExtractorProfileStore,
  type SemanticMemoryExtractor,
  type SemanticMemoryStore,
  type EpisodicMemoryStore,
  type MemoryActivityStore,
} from "@pragma/memory";

import { createDesktopMemorySubjectIdentityStore } from "./memory-subject-identity.ts";

export type DesktopMemoryMutationResult =
  | {
      readonly module: "episodic";
      readonly record: import("@pragma/memory").EpisodicMemoryRecord;
    }
  | {
      readonly module: "semantic";
      readonly record: import("@pragma/shared").SemanticFact;
    };

export interface DesktopMemoryPlane {
  readonly executionStore: FileExecutionStore;
  readonly policies: MemoryPolicyStore;
  readonly extractorProfiles: MemoryExtractorProfileStore;
  readonly semanticStore: SemanticMemoryStore;
  readonly episodicStore: EpisodicMemoryStore;
  readonly activity: MemoryActivityStore;
  readonly contextStore: import("@pragma/core").ExpertAgentContextStore;
  setEpisodicExtractor(extractor: EpisodicMemoryExtractor | undefined): Promise<void>;
  setSemanticExtractor(extractor: SemanticMemoryExtractor | undefined): Promise<void>;
  registerMemoryExecutionContext(input: {
    readonly executionId: string;
    readonly projectId: string;
  }): Promise<void>;
  reviseSemanticFact(
    input: Omit<Parameters<SemanticMemoryStore["revise"]>[0], "actorRef" | "now">,
  ): Promise<import("@pragma/shared").SemanticFact>;
  verifySemanticFact(
    input: Omit<Parameters<SemanticMemoryStore["verify"]>[0], "actorRef" | "now">,
  ): Promise<import("@pragma/shared").SemanticFact>;
  tightenMemoryAccess(input: {
    readonly module: "episodic" | "semantic";
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
    readonly bindings?: import("@pragma/shared").MemoryRevisionBinding[] | undefined;
    readonly visibility?: import("@pragma/shared").MemoryVisibilityPolicy | undefined;
  }): Promise<DesktopMemoryMutationResult>;
  invalidateMemoryItem(input: {
    readonly module: "episodic" | "semantic";
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<DesktopMemoryMutationResult>;
  forgetMemoryItem(input: {
    readonly module: "episodic" | "semantic";
    readonly id: string;
    readonly expectedRevision: number;
    readonly reason: string;
  }): Promise<void>;
  wakeMemoryJobs(): Promise<void>;
  getStatus(): Promise<{
    readonly state: "running" | "stopped" | "degraded";
    readonly feed: { readonly lastSequence: number; readonly eventCount: number };
    readonly delivery: { readonly pending: number; readonly quarantined: number };
    readonly lastError?: { readonly code: string; readonly occurredAt: string } | undefined;
    readonly modules: readonly import("@pragma/shared").MemoryModuleDiagnostic[];
  }>;
  start(): void;
  stop(): Promise<void>;
}

export async function createDesktopMemoryPlane(options: {
  readonly pragmaHome: string;
  readonly logger: PragmaLogger;
  readonly pollIntervalMs?: number | undefined;
}): Promise<DesktopMemoryPlane> {
  const canonical = await createFileCanonicalEventFeed({ pragmaHome: options.pragmaHome });
  const executionStore = createFileExecutionStore({
    pragmaHome: options.pragmaHome,
    canonicalEventFeed: canonical,
    onCanonicalEventDeliveryError: (error, context) => {
      options.logger.warn(
        "desktop.memory_event_delivery_deferred",
        "A canonical event handoff was preserved for background recovery.",
        { ...context, error },
      );
    },
  });
  const state = createFileMemoryPipelineStateStore({ pragmaHome: options.pragmaHome });
  const policies = createFileMemoryPolicyStore({ pragmaHome: options.pragmaHome });
  const extractorProfiles = createFileMemoryExtractorProfileStore({
    pragmaHome: options.pragmaHome,
  });
  const publisher = createMemoryEvidencePublisher(canonical);
  const registry = new MemoryModuleRegistry();
  const episodic = await createEpisodicMemoryModule({ pragmaHome: options.pragmaHome });
  const semantic = await createSemanticMemoryModule({ pragmaHome: options.pragmaHome });
  const subjectIdentities = createDesktopMemorySubjectIdentityStore({
    pragmaHome: options.pragmaHome,
  });
  const activity = createMemoryActivityStore({ pragmaHome: options.pragmaHome });
  registry.register(episodic);
  registry.register(semantic);
  const contextStore = createFederatedMemoryContextStore(registry, {
    resolveRecallScope: async (context) => {
      const executionId = readExecutionRunScope(context).executionId;
      const executionContext =
        executionId === undefined ? undefined : await activity.getExecutionContext(executionId);
      return await resolveDesktopMemoryRecallScope(
        policies,
        context,
        new Date(),
        executionContext?.principalRefs ?? [],
      );
    },
    activity,
  });
  const adapter = createExecutionEvidenceAdapter({
    source: canonical,
    publisher,
    checkpoints: state,
    deadLetters: state,
    policies,
    activity,
  });
  const scheduler = createMemoryPipelineScheduler({
    registry,
    feed: createMemoryEvidenceFeed(canonical),
    publisher,
    checkpoints: state,
    deadLetters: state,
    outbox: state,
  });
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let lastError: { readonly code: string; readonly occurredAt: string } | undefined;

  const markDegraded = (code: string, error?: unknown): void => {
    if (lastError?.code === code) return;
    lastError = { code, occurredAt: new Date().toISOString() };
    options.logger.error(
      "desktop.memory_pipeline_degraded",
      "The Memory pipeline is degraded and will keep retrying.",
      error ?? new Error(code),
      { code },
    );
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = tick().finally(() => {
        running = undefined;
        schedule();
      });
    }, options.pollIntervalMs ?? 1_000);
  };

  const tick = async (): Promise<void> => {
    try {
      const recovery = await executionStore.recoverPendingCanonicalEvents();
      const adapted = await adapter.runOnce();
      await scheduler.runOnce();
      if (recovery.quarantined > 0) {
        markDegraded("canonical_event_handoff_quarantined");
      } else if (recovery.failed > 0) {
        markDegraded("canonical_event_delivery_failed");
      } else {
        lastError = undefined;
      }
      if (recovery.recovered > 0 || adapted.published > 0) {
        options.logger.info("desktop.memory_pipeline_progress", "Memory pipeline advanced.", {
          recovered: recovery.recovered,
          pending: recovery.pending,
          failed: recovery.failed,
          published: adapted.published,
          skipped: adapted.skipped,
        });
      }
    } catch (error) {
      markDegraded("memory_pipeline_iteration_failed", error);
    }
  };

  return {
    executionStore,
    policies,
    extractorProfiles,
    semanticStore: semantic.store,
    episodicStore: episodic.store,
    activity,
    contextStore,
    async setEpisodicExtractor(extractor) {
      await episodic.setExtractor(extractor);
      scheduler.wake();
    },
    async setSemanticExtractor(extractor) {
      await semantic.setExtractor(extractor);
      scheduler.wake();
    },
    async registerMemoryExecutionContext(input) {
      const localUser = await subjectIdentities.getLocalUserRef();
      const principalRefs = [localUser, { type: "pragma.project" as const, id: input.projectId }];
      await activity.registerExecutionContext({ executionId: input.executionId, principalRefs });
      await semantic.registerExecutionSubjects({
        executionId: input.executionId,
        subjectRefs: principalRefs,
      });
      scheduler.wake();
    },
    async reviseSemanticFact(input) {
      return await semantic.store.revise({
        ...input,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      });
    },
    async verifySemanticFact(input) {
      return await semantic.store.verify({
        ...input,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      });
    },
    async tightenMemoryAccess(input) {
      const actorRef = await subjectIdentities.getLocalUserRef();
      const common = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actorRef,
        now: new Date(),
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      };
      return input.module === "episodic"
        ? { module: "episodic", record: await episodic.store.tightenAccess(common) }
        : { module: "semantic", record: await semantic.store.tightenAccess(common) };
    },
    async invalidateMemoryItem(input) {
      const common = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      };
      return input.module === "episodic"
        ? { module: "episodic", record: await episodic.store.invalidate(common) }
        : { module: "semantic", record: await semantic.store.invalidate(common) };
    },
    async forgetMemoryItem(input) {
      const common = {
        id: input.id,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        actorRef: await subjectIdentities.getLocalUserRef(),
        now: new Date(),
      };
      if (input.module === "episodic") await episodic.store.forget(common);
      else await semantic.store.forget(common);
    },
    async wakeMemoryJobs() {
      await Promise.all([
        episodic.store.wakeNeedsAttention(new Date()),
        semantic.store.wakeNeedsAttention(new Date()),
      ]);
      scheduler.wake();
    },
    async getStatus() {
      const delivery = await executionStore.inspectCanonicalEventDelivery();
      const modules: import("@pragma/shared").MemoryModuleDiagnostic[] = [];
      for (const module of registry.list()) {
        const diagnostic = registry.diagnostic(module.descriptor.id);
        if (diagnostic === undefined) continue;
        if (
          module.descriptor.id !== episodic.descriptor.id &&
          module.descriptor.id !== semantic.descriptor.id
        ) {
          modules.push(diagnostic);
          continue;
        }
        const work =
          module.descriptor.id === episodic.descriptor.id
            ? await episodic.store.inspect()
            : await semantic.store.inspect();
        modules.push({
          ...diagnostic,
          work: {
            records: "episodes" in work ? work.episodes : work.facts,
            pending: work.pending,
            running: work.running,
            needsAttention: work.needsAttention,
            rejected: work.rejected,
          },
        });
      }
      return {
        state: stopped
          ? "stopped"
          : lastError !== undefined || delivery.quarantined > 0
            ? "degraded"
            : "running",
        feed: await canonical.inspect(),
        delivery,
        ...(lastError === undefined ? {} : { lastError }),
        modules,
      };
    },
    start() {
      if (!stopped) return;
      stopped = false;
      running = tick().finally(() => {
        running = undefined;
        schedule();
      });
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await running;
      await scheduler.stop();
      episodic.close();
      semantic.close();
      canonical.close();
    },
  };
}

export async function resolveDesktopMemoryRecallScope(
  policies: Pick<MemoryPolicyStore, "resolveAt">,
  context: ExpertAgentRunContext | undefined,
  now: Date = new Date(),
  principalRefs: readonly import("@pragma/shared").MemorySubjectRef[] = [],
): Promise<MemoryRecallScope | undefined> {
  const source = context?.source;
  const currentExpertId = context?.attributes?.[EXECUTION_CURRENT_EXPERT_ID_ATTR];
  const scope = MemoryRecallScopeSchema.safeParse({
    rootRef: { type: source?.type, id: source?.id },
    expertRef: { type: "pragma.expert", id: currentExpertId },
    ...(principalRefs.length === 0 ? {} : { principalRefs }),
  });
  if (!scope.success) return undefined;
  const policy = await policies.resolveAt({
    rootRef: scope.data.rootRef,
    producerRefs: [scope.data.expertRef],
    occurredAt: now.toISOString(),
  });
  return policy.recall ? scope.data : undefined;
}
