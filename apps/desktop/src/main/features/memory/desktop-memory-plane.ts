import {
  createFileCanonicalEventFeed,
  createFileExecutionStore,
  type FileExecutionStore,
  type PragmaLogger,
} from "@pragma/core";
import {
  MemoryModuleRegistry,
  createEpisodicMemoryModule,
  createFileMemoryExtractorProfileStore,
  createExecutionEvidenceAdapter,
  createFederatedMemoryContextStore,
  createFileMemoryPolicyStore,
  createFileMemoryPipelineStateStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  type MemoryPolicyStore,
  type EpisodicMemoryExtractor,
  type MemoryExtractorProfileStore,
} from "@pragma/memory";

export interface DesktopMemoryPlane {
  readonly executionStore: FileExecutionStore;
  readonly policies: MemoryPolicyStore;
  readonly extractorProfiles: MemoryExtractorProfileStore;
  readonly contextStore: import("@pragma/core").ExpertAgentContextStore;
  setEpisodicExtractor(extractor: EpisodicMemoryExtractor | undefined): Promise<void>;
  wakeEpisodicJobs(): Promise<void>;
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
  registry.register(episodic);
  const contextStore = createFederatedMemoryContextStore(registry, {
    canRecall: async (context) => {
      const source = context?.source;
      const rootRef =
        source?.id === undefined || !source.type.includes(".")
          ? undefined
          : { type: source.type, id: source.id };
      return (
        await policies.resolveAt({
          ...(rootRef === undefined ? {} : { rootRef }),
          occurredAt: new Date().toISOString(),
        })
      ).recall;
    },
  });
  const adapter = createExecutionEvidenceAdapter({
    source: canonical,
    publisher,
    checkpoints: state,
    deadLetters: state,
    policies,
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
    contextStore,
    async setEpisodicExtractor(extractor) {
      await episodic.setExtractor(extractor);
      scheduler.wake();
    },
    async wakeEpisodicJobs() {
      await episodic.store.wakeNeedsAttention(new Date());
      scheduler.wake();
    },
    async getStatus() {
      const delivery = await executionStore.inspectCanonicalEventDelivery();
      const modules: import("@pragma/shared").MemoryModuleDiagnostic[] = [];
      for (const module of registry.list()) {
        const diagnostic = registry.diagnostic(module.descriptor.id);
        if (diagnostic === undefined) continue;
        if (module.descriptor.id !== episodic.descriptor.id) {
          modules.push(diagnostic);
          continue;
        }
        const work = await episodic.store.inspect();
        modules.push({
          ...diagnostic,
          work: {
            records: work.episodes,
            pending: work.pending,
            running: work.running,
            needsAttention: work.needsAttention,
            rejected: work.rejectedLowValue,
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
      canonical.close();
    },
  };
}
