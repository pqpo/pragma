import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  PragmaPaths,
  StaticContextStore,
  withFileLock,
  type ExpertAgentContextStore,
} from "@pragma/core";
import { MemoryEvidenceEnvelopeSchema, type MemoryEvidenceEnvelope } from "@pragma/shared";
import { z } from "zod";

import type { MemoryModule } from "../pipeline/memory-module.ts";

const ProbeRecordSchema = z.object({
  schemaVersion: z.literal("pragma.memory-probe/v1"),
  messageIds: z.array(z.string().min(1)),
  updatedAt: z.string().datetime(),
});

export function createProbeMemoryModule(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly id?: string | undefined;
    readonly prefix?: string | undefined;
    readonly fail?: boolean | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): MemoryModule {
  const id = options.id ?? "pragma.memory.probe";
  const prefix = options.prefix ?? "probe";
  const now = options.now ?? (() => new Date());
  const paths = new PragmaPaths(options);
  const recordPath = join(paths.memoryModuleDataRoot(id), "records.json");
  const lockPath = join(paths.memoryModuleStateRoot(id), ".projection.lock");
  const contextProvider = createProbeContextStore(recordPath);

  return {
    descriptor: {
      id,
      version: "1.0.0",
      pathPrefix: prefix,
      storageModel: "dynamic-projection",
      purpose: "projection",
      contextLayers: {
        usagePrompt: "Use probe memory only to verify Memory Plane delivery in tests.",
        summaryPath: "summary.md",
        indexPath: "index.md",
        itemsPrefix: "items/",
        evidencePrefix: "evidence/",
        summaryMaxBytes: 512,
        indexMaxBytes: 1_024,
      },
    },
    subscriptions: [
      {
        topic: "execution.message.appended",
        schemaRefs: ["pragma.memory.execution-message/v1", "pragma.memory.execution-message/v2"],
      },
    ],
    contextProvider,
    async consume(envelopes) {
      if (options.fail === true) throw new Error("Probe Module configured failure.");
      await withFileLock(lockPath, async () => {
        const current = await readProbeRecord(recordPath, now);
        const ids = new Set(current.messageIds);
        for (const envelope of envelopes) ids.add(envelope.messageId);
        await writeJsonAtomic(recordPath, {
          ...current,
          messageIds: [...ids].toSorted(),
          updatedAt: now().toISOString(),
        });
      });
      return {
        derivedEvents: envelopes.map((envelope) => derivedProbeEvent(envelope)),
      };
    },
  };
}

function createProbeContextStore(recordPath: string): ExpertAgentContextStore {
  const delegate = async () => {
    const record = await readProbeRecord(recordPath, () => new Date());
    return new StaticContextStore([
      {
        id: "summary.md",
        content: `# Probe Memory\n\nObserved ${record.messageIds.length} evidence messages.\n`,
        metadata: {
          description: "Summary of Probe Memory evidence delivery.",
          trigger: "model_decision",
          priority: "low",
          trustLevel: "system",
          sensitivity: "internal",
        },
      },
      {
        id: "index.md",
        content: ["# Probe Evidence", "", ...record.messageIds.map((id) => `- ${id}`), ""].join(
          "\n",
        ),
        metadata: {
          description: "Evidence observed by the test Probe Memory Module.",
          trigger: "model_decision",
          priority: "low",
          trustLevel: "system",
          sensitivity: "internal",
        },
      },
      {
        id: "items/entries.md",
        content: ["# Probe Evidence", "", ...record.messageIds.map((id) => `- ${id}`), ""].join(
          "\n",
        ),
        metadata: {
          description: "Detailed Probe Memory entries.",
          trigger: "manual",
          priority: "low",
          trustLevel: "system",
          sensitivity: "internal",
        },
      },
    ]);
  };
  return {
    listContext: async (input) => await (await delegate()).listContext(input),
    readContext: async (input) => await (await delegate()).readContext(input),
    searchContext: async (input) => await (await delegate()).searchContext(input),
    addContext: async (input) => await (await delegate()).addContext(input),
    editContext: async (input) => await (await delegate()).editContext(input),
    deleteContext: async (input) => await (await delegate()).deleteContext(input),
  };
}

function derivedProbeEvent(source: MemoryEvidenceEnvelope): MemoryEvidenceEnvelope {
  return MemoryEvidenceEnvelopeSchema.parse({
    ...source,
    messageId: createHash("sha256")
      .update(JSON.stringify(["pragma.memory.probe/v1", source.messageId]))
      .digest("hex"),
    topic: "memory.probe.updated",
    schemaRef: "pragma.memory.probe-update/v1",
    causationId: source.messageId,
    payload: { sourceMessageId: source.messageId },
  });
}

async function readProbeRecord(path: string, now: () => Date) {
  try {
    return ProbeRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return ProbeRecordSchema.parse({
      schemaVersion: "pragma.memory-probe/v1",
      messageIds: [],
      updatedAt: now().toISOString(),
    });
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
