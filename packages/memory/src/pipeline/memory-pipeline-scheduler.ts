import { createHash } from "node:crypto";

import { MemoryModuleDiagnosticSchema, type MemoryEvidenceEnvelope } from "@pragma/shared";

import type { MemoryEvidenceFeed, MemoryEvidencePublisher } from "../evidence/evidence-feed.ts";
import type {
  MemoryConsumerCheckpointStore,
  MemoryDeadLetterStore,
  MemoryDerivedEventOutboxEntry,
  MemoryDerivedEventOutboxStore,
} from "./pipeline-state-store.ts";
import { MemoryModuleRegistry, type MemoryModule } from "./memory-module.ts";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_ATTEMPTS = 5;

export interface MemoryPipelineScheduler {
  start(): void;
  wake(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

export function createMemoryPipelineScheduler(options: {
  readonly registry: MemoryModuleRegistry;
  readonly feed: MemoryEvidenceFeed;
  readonly publisher: MemoryEvidencePublisher;
  readonly checkpoints: MemoryConsumerCheckpointStore;
  readonly deadLetters: MemoryDeadLetterStore;
  readonly outbox: MemoryDerivedEventOutboxStore;
  readonly batchSize?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly isEnabled?: (() => Promise<boolean>) | undefined;
  readonly setTimer?:
    ((callback: () => void, delay: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
}): MemoryPipelineScheduler {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;

  const schedule = (delay = pollIntervalMs): void => {
    if (stopped || timer !== undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      void runOnce()
        .catch(() => undefined)
        .finally(() => schedule());
    }, delay);
  };

  const runOnce = async (): Promise<void> => {
    if (running !== undefined) return await running;
    if (options.isEnabled !== undefined && !(await options.isEnabled())) return;
    running = Promise.all(
      options.registry.list().map(async (module) => {
        try {
          await processModule({
            module,
            registry: options.registry,
            feed: options.feed,
            publisher: options.publisher,
            checkpoints: options.checkpoints,
            deadLetters: options.deadLetters,
            outbox: options.outbox,
            batchSize,
            now,
          });
        } catch (error) {
          await recordUnavailableDiagnostic({
            module,
            registry: options.registry,
            feed: options.feed,
            checkpoints: options.checkpoints,
            now,
            error,
          });
        }
        if (module.runBackgroundOnce !== undefined) {
          try {
            await module.runBackgroundOnce();
          } catch (error) {
            await recordUnavailableDiagnostic({
              module,
              registry: options.registry,
              feed: options.feed,
              checkpoints: options.checkpoints,
              now,
              error,
            });
          }
        }
      }),
    ).then(() => undefined);
    try {
      await running;
    } finally {
      running = undefined;
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    wake() {
      if (stopped) return;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      schedule(0);
    },
    runOnce,
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      await running;
    },
  };
}

async function processModule(input: {
  readonly module: MemoryModule;
  readonly registry: MemoryModuleRegistry;
  readonly feed: MemoryEvidenceFeed;
  readonly publisher: MemoryEvidencePublisher;
  readonly checkpoints: MemoryConsumerCheckpointStore;
  readonly deadLetters: MemoryDeadLetterStore;
  readonly outbox: MemoryDerivedEventOutboxStore;
  readonly batchSize: number;
  readonly now: () => Date;
}): Promise<void> {
  await flushPendingOutbox(input);
  const state = await input.checkpoints.read(input.module.descriptor.id);
  if (state.retryAfter !== undefined && Date.parse(state.retryAfter) > input.now().getTime())
    return;
  const feedDiagnostic = await input.feed.inspect();
  const page = await input.feed.read({
    after: { sequence: state.sequence },
    limit: input.batchSize,
  });
  const subscribed = page.items.filter(
    (envelope) =>
      (input.module.descriptor.purpose === "projection" ||
        envelope.policySnapshot.learning !== "disabled") &&
      subscribes(input.module, envelope),
  );
  const invalid = subscribed.filter((envelope) => !input.registry.schemas.validate(envelope));
  const invalidIds = new Set(invalid.map((envelope) => envelope.messageId));
  const matching = subscribed.filter((envelope) => !invalidIds.has(envelope.messageId));
  for (const envelope of invalid) {
    await input.deadLetters.put({
      schemaVersion: "pragma.memory-dead-letter/v1",
      consumerId: input.module.descriptor.id,
      messageId: envelope.messageId,
      sequence: page.nextCursor.sequence,
      errorCode: "payload_schema_invalid",
      failedAt: input.now().toISOString(),
    });
  }
  const skipped = page.items.length - matching.length + page.unreadable.length;
  if (page.nextCursor.sequence === state.sequence) {
    updateDiagnostic(input, state, feedDiagnostic.lastSequence, "healthy");
    return;
  }

  if (matching.length === 0) {
    const next = await input.checkpoints.update(input.module.descriptor.id, (current) => ({
      ...current,
      sequence: page.nextCursor.sequence,
      skipped: current.skipped + skipped,
      deadLettered: current.deadLettered + invalid.length,
      retryAfter: undefined,
      updatedAt: input.now().toISOString(),
    }));
    updateDiagnostic(input, next, feedDiagnostic.lastSequence, "healthy");
    return;
  }

  const deliveryId = createHash("sha256")
    .update(JSON.stringify(matching.map((item) => item.messageId)))
    .digest("hex");
  let result: Awaited<ReturnType<MemoryModule["consume"]>>;
  try {
    result = await input.module.consume(matching);
  } catch (error) {
    const attempt = (state.attempts[deliveryId] ?? 0) + 1;
    if (attempt >= MAX_ATTEMPTS) {
      for (const envelope of matching) {
        await input.deadLetters.put({
          schemaVersion: "pragma.memory-dead-letter/v1",
          consumerId: input.module.descriptor.id,
          messageId: envelope.messageId,
          sequence: page.nextCursor.sequence,
          errorCode: errorCode(error),
          failedAt: input.now().toISOString(),
        });
      }
      const next = await input.checkpoints.update(input.module.descriptor.id, (current) => ({
        ...current,
        sequence: page.nextCursor.sequence,
        attempts: {},
        retryAfter: undefined,
        retried: current.retried + 1,
        // Invalid subscribed payloads were already isolated before invoking the Module.
        deadLettered: current.deadLettered + matching.length + invalid.length,
        skipped: current.skipped + skipped,
        updatedAt: input.now().toISOString(),
      }));
      updateDiagnostic(input, next, feedDiagnostic.lastSequence, "degraded", errorCode(error));
      return;
    }
    const retryAfter = new Date(
      input.now().getTime() + Math.min(16_000, 1_000 * 2 ** (attempt - 1)),
    ).toISOString();
    const next = await input.checkpoints.update(input.module.descriptor.id, (current) => ({
      ...current,
      attempts: { ...current.attempts, [deliveryId]: attempt },
      retryAfter,
      retried: current.retried + 1,
      updatedAt: input.now().toISOString(),
    }));
    updateDiagnostic(input, next, feedDiagnostic.lastSequence, "degraded", errorCode(error));
    return;
  }

  const outboxEntry: MemoryDerivedEventOutboxEntry = {
    schemaVersion: "pragma.memory-derived-event-outbox/v1",
    consumerId: input.module.descriptor.id,
    deliveryId,
    targetSequence: page.nextCursor.sequence,
    events: [...(result.derivedEvents ?? [])],
    processed: matching.length,
    skipped,
    deadLettered: invalid.length,
    createdAt: input.now().toISOString(),
  };
  await input.outbox.enqueue(outboxEntry);
  const next = await completeOutboxEntry(input, outboxEntry);
  updateDiagnostic(input, next, feedDiagnostic.lastSequence, "healthy");
}

async function flushPendingOutbox(
  input: Pick<
    Parameters<typeof processModule>[0],
    "module" | "publisher" | "checkpoints" | "outbox" | "now"
  >,
): Promise<void> {
  const pending = await input.outbox.listPending(input.module.descriptor.id);
  for (const entry of pending.toSorted(
    (left, right) => left.targetSequence - right.targetSequence,
  )) {
    await completeOutboxEntry(input, entry);
  }
}

async function completeOutboxEntry(
  input: Pick<
    Parameters<typeof processModule>[0],
    "module" | "publisher" | "checkpoints" | "outbox" | "now"
  >,
  entry: MemoryDerivedEventOutboxEntry,
) {
  const current = await input.checkpoints.read(input.module.descriptor.id);
  if (current.sequence < entry.targetSequence) {
    await input.publisher.publish(entry.events);
    const next = await input.checkpoints.update(input.module.descriptor.id, (checkpoint) => ({
      ...checkpoint,
      sequence: entry.targetSequence,
      attempts: {},
      retryAfter: undefined,
      processed: checkpoint.processed + entry.processed,
      skipped: checkpoint.skipped + entry.skipped,
      deadLettered: checkpoint.deadLettered + entry.deadLettered,
      updatedAt: input.now().toISOString(),
    }));
    await input.outbox.acknowledge(input.module.descriptor.id, entry.deliveryId);
    return next;
  }
  await input.outbox.acknowledge(input.module.descriptor.id, entry.deliveryId);
  return current;
}

async function recordUnavailableDiagnostic(input: {
  readonly module: MemoryModule;
  readonly registry: MemoryModuleRegistry;
  readonly feed: MemoryEvidenceFeed;
  readonly checkpoints: MemoryConsumerCheckpointStore;
  readonly now: () => Date;
  readonly error: unknown;
}): Promise<void> {
  try {
    const [state, feed] = await Promise.all([
      input.checkpoints.read(input.module.descriptor.id),
      input.feed.inspect(),
    ]);
    updateDiagnostic(input, state, feed.lastSequence, "unavailable", errorCode(input.error));
  } catch {
    // Diagnostics must not turn a local Module failure into a scheduler-wide failure.
  }
}

function subscribes(module: MemoryModule, envelope: MemoryEvidenceEnvelope): boolean {
  return module.subscriptions.some(
    (subscription) =>
      subscription.topic === envelope.topic && subscription.schemaRefs.includes(envelope.schemaRef),
  );
}

function updateDiagnostic(
  input: Pick<Parameters<typeof processModule>[0], "module" | "registry" | "now">,
  state: Awaited<ReturnType<MemoryConsumerCheckpointStore["read"]>>,
  feedLastSequence: number,
  status: "healthy" | "degraded" | "unavailable",
  lastErrorCode?: string,
): void {
  input.registry.setDiagnostic(
    MemoryModuleDiagnosticSchema.parse({
      moduleId: input.module.descriptor.id,
      moduleVersion: input.module.descriptor.version,
      status,
      cursor: { sequence: state.sequence },
      lag: Math.max(0, feedLastSequence - state.sequence),
      processed: state.processed,
      retried: state.retried,
      deadLettered: state.deadLettered,
      skipped: state.skipped,
      ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
      updatedAt: input.now().toISOString(),
    }),
  );
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "module_consume_failed";
}
