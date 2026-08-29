import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  withFileLock,
  type RuntimeUsageObservation,
  type UsageSink,
} from "@pragma/core";

const USAGE_SCHEMA_VERSION = "pragma.local-host-usage/v1" as const;

interface UsageLedger {
  readonly schemaVersion: typeof USAGE_SCHEMA_VERSION;
  readonly observations: Readonly<Record<string, RuntimeUsageObservation>>;
}

export interface LocalHostUsageSink extends UsageSink {
  readonly list: () => Promise<readonly RuntimeUsageObservation[]>;
}

/**
 * Durable Host usage sink. Observation IDs are the idempotency key, while a
 * conflicting payload is treated as corruption rather than double-counted.
 */
export function createLocalHostUsageSink(options: {
  readonly path: string;
}): LocalHostUsageSink {
  const lockPath = `${options.path}.lock`;
  const readLedger = async (): Promise<UsageLedger> => {
    try {
      const parsed = JSON.parse(await readFile(options.path, "utf8")) as Partial<UsageLedger>;
      if (parsed.schemaVersion !== USAGE_SCHEMA_VERSION || parsed.observations === undefined) {
        throw new Error("Unsupported Local Host usage ledger.");
      }
      return {
        schemaVersion: USAGE_SCHEMA_VERSION,
        observations: parsed.observations,
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { schemaVersion: USAGE_SCHEMA_VERSION, observations: {} };
      }
      throw error;
    }
  };
  const writeLedger = async (ledger: UsageLedger): Promise<void> => {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    const temporary = `${options.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
    await rename(temporary, options.path);
  };

  return {
    async record(observation) {
      await withFileLock(
        lockPath,
        async () => {
          const ledger = await readLedger();
          const existing = ledger.observations[observation.observationId];
          if (existing !== undefined) {
            if (observationSignature(existing) !== observationSignature(observation)) {
              throw new Error(`Conflicting usage observation: ${observation.observationId}.`);
            }
            return;
          }
          await writeLedger({
            schemaVersion: USAGE_SCHEMA_VERSION,
            observations: {
              ...ledger.observations,
              [observation.observationId]: observation,
            },
          });
        },
        { operation: "local-host-usage" },
      );
    },
    async list() {
      const ledger = await readLedger();
      return Object.values(ledger.observations).toSorted((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt),
      );
    },
  };
}

function observationSignature(observation: RuntimeUsageObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        observationId: observation.observationId,
        occurredAt: observation.occurredAt,
        executionId: observation.executionId,
        invocationId: observation.invocationId,
        contextId: observation.contextId,
        runId: observation.runId,
        runtimeId: observation.runtimeId,
        modelSelection: observation.modelSelection,
        executor: observation.executor,
        usage: observation.usage,
      }),
    )
    .digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
