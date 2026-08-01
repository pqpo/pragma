import {
  createFileCanonicalEventFeed,
  createFileExecutionStore,
  type FileExecutionStore,
  type PragmaLogger,
} from "@pragma/core";
import {
  MemoryModuleRegistry,
  createExecutionEvidenceAdapter,
  createFileMemoryPolicyStore,
  createFileMemoryPipelineStateStore,
  createMemoryEvidenceFeed,
  createMemoryEvidencePublisher,
  createMemoryPipelineScheduler,
  type MemoryPolicyStore,
} from "@pragma/memory";

export interface DesktopMemoryPlane {
  readonly executionStore: FileExecutionStore;
  readonly policies: MemoryPolicyStore;
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
  const publisher = createMemoryEvidencePublisher(canonical);
  const registry = new MemoryModuleRegistry();
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
    async getStatus() {
      const delivery = await executionStore.inspectCanonicalEventDelivery();
      return {
        state: stopped
          ? "stopped"
          : lastError !== undefined || delivery.quarantined > 0
            ? "degraded"
            : "running",
        feed: await canonical.inspect(),
        delivery,
        ...(lastError === undefined ? {} : { lastError }),
        modules: registry.list().flatMap((module) => {
          const diagnostic = registry.diagnostic(module.descriptor.id);
          return diagnostic === undefined ? [] : [diagnostic];
        }),
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
      canonical.close();
    },
  };
}
