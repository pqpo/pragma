import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import { MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import { z } from "zod";

const ConsumerStateSchema = z.object({
  schemaVersion: z.literal("pragma.memory-consumer-state/v1"),
  consumerId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  attempts: z.record(z.string(), z.number().int().nonnegative()),
  retryAfter: z.string().datetime().optional(),
  processed: z.number().int().nonnegative(),
  retried: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

const DeadLetterSchema = z.object({
  schemaVersion: z.literal("pragma.memory-dead-letter/v1"),
  consumerId: z.string().min(1),
  messageId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  errorCode: z.string().min(1),
  failedAt: z.string().datetime(),
});

const DerivedEventOutboxEntrySchema = z.object({
  schemaVersion: z.literal("pragma.memory-derived-event-outbox/v1"),
  consumerId: z.string().min(1),
  deliveryId: z.string().min(1),
  targetSequence: z.number().int().nonnegative(),
  events: z.array(MemoryEvidenceEnvelopeSchema),
  processed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type MemoryConsumerState = z.infer<typeof ConsumerStateSchema>;
export type MemoryDeadLetter = z.infer<typeof DeadLetterSchema>;
export type MemoryDerivedEventOutboxEntry = z.infer<typeof DerivedEventOutboxEntrySchema>;

export interface MemoryConsumerCheckpointStore {
  read(consumerId: string): Promise<MemoryConsumerState>;
  update(
    consumerId: string,
    updater: (current: MemoryConsumerState) => MemoryConsumerState,
  ): Promise<MemoryConsumerState>;
}

export interface MemoryDeadLetterStore {
  put(entry: MemoryDeadLetter): Promise<void>;
  list(consumerId: string): Promise<readonly MemoryDeadLetter[]>;
}

export interface MemoryDerivedEventOutboxStore {
  enqueue(entry: MemoryDerivedEventOutboxEntry): Promise<void>;
  listPending(consumerId: string): Promise<readonly MemoryDerivedEventOutboxEntry[]>;
  acknowledge(consumerId: string, deliveryId: string): Promise<void>;
}

export function createFileMemoryPipelineStateStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): MemoryConsumerCheckpointStore & MemoryDeadLetterStore & MemoryDerivedEventOutboxStore {
  const paths = new PragmaPaths(options);
  const now = options.now ?? (() => new Date());
  const statePath = (consumerId: string) =>
    join(paths.memoryModuleStateRoot(consumerId), "consumer.json");
  const deadLetterPath = (consumerId: string) =>
    join(paths.memoryModuleStateRoot(consumerId), "dead-letters.json");
  const lockPath = (consumerId: string) => join(paths.memoryModuleStateRoot(consumerId), ".lock");
  const outboxPath = (consumerId: string) =>
    join(paths.memoryModuleStateRoot(consumerId), "derived-event-outbox.json");

  return {
    async read(consumerId) {
      return await readState(statePath(consumerId), consumerId, now);
    },

    async update(consumerId, updater) {
      return await withFileLock(lockPath(consumerId), async () => {
        const current = await readState(statePath(consumerId), consumerId, now);
        const next = ConsumerStateSchema.parse(updater(current));
        if (next.consumerId !== consumerId || next.sequence < current.sequence) {
          throw new Error(`Invalid Memory checkpoint transition for ${consumerId}.`);
        }
        await writeJsonAtomic(statePath(consumerId), next);
        return next;
      });
    },

    async put(input) {
      const entry = DeadLetterSchema.parse(input);
      await withFileLock(lockPath(entry.consumerId), async () => {
        const existing = await readDeadLetters(deadLetterPath(entry.consumerId));
        if (existing.some((candidate) => candidate.messageId === entry.messageId)) return;
        await writeJsonAtomic(deadLetterPath(entry.consumerId), [...existing, entry]);
      });
    },

    async list(consumerId) {
      return await readDeadLetters(deadLetterPath(consumerId));
    },

    async enqueue(input) {
      const entry = DerivedEventOutboxEntrySchema.parse(input);
      await withFileLock(lockPath(entry.consumerId), async () => {
        const existing = await readOutbox(outboxPath(entry.consumerId));
        const duplicate = existing.find((candidate) => candidate.deliveryId === entry.deliveryId);
        if (duplicate !== undefined) {
          if (JSON.stringify(duplicate) !== JSON.stringify(entry)) {
            throw new Error(`Conflicting Memory outbox delivery: ${entry.deliveryId}`);
          }
          return;
        }
        await writeJsonAtomic(outboxPath(entry.consumerId), [...existing, entry]);
      });
    },

    async listPending(consumerId) {
      return await readOutbox(outboxPath(consumerId));
    },

    async acknowledge(consumerId, deliveryId) {
      await withFileLock(lockPath(consumerId), async () => {
        const existing = await readOutbox(outboxPath(consumerId));
        const next = existing.filter((entry) => entry.deliveryId !== deliveryId);
        if (next.length === existing.length) return;
        await writeJsonAtomic(outboxPath(consumerId), next);
      });
    },
  };
}

async function readState(
  path: string,
  consumerId: string,
  now: () => Date,
): Promise<MemoryConsumerState> {
  const value = await readJson(path);
  if (value === undefined) {
    return ConsumerStateSchema.parse({
      schemaVersion: "pragma.memory-consumer-state/v1",
      consumerId,
      sequence: 0,
      attempts: {},
      processed: 0,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
      updatedAt: now().toISOString(),
    });
  }
  return ConsumerStateSchema.parse(value);
}

async function readDeadLetters(path: string): Promise<MemoryDeadLetter[]> {
  const value = await readJson(path);
  return value === undefined ? [] : DeadLetterSchema.array().parse(value);
}

async function readOutbox(path: string): Promise<MemoryDerivedEventOutboxEntry[]> {
  const value = await readJson(path);
  return value === undefined ? [] : DerivedEventOutboxEntrySchema.array().parse(value);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
