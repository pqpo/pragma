import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  MemorySafeExecutionMessagePayloadSchema,
  MemorySafeToolEventPayloadSchema,
  MemoryToolContentPayloadSchema,
  type MemoryEvidenceEnvelope,
} from "@pragma/shared";
import { z } from "zod";

import {
  EMPTY_MEMORY_EVIDENCE_OMISSION_STATS,
  summarizeMemoryEvidenceOmissions,
  type MemoryEvidenceOmissionStats,
} from "../storage/bounded-evidence.ts";

export const MemoryExtractionSettingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-extraction-settings/v1"),
    revision: z.number().int().nonnegative(),
    allowToolAssisted: z
      .object({
        episodic: z.boolean(),
        semantic: z.boolean(),
      })
      .strict(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type MemoryExtractionSettings = z.infer<typeof MemoryExtractionSettingsSchema>;

export interface MemoryExtractionSettingsStore {
  get(): Promise<MemoryExtractionSettings>;
  update(input: {
    readonly expectedRevision: number;
    readonly allowToolAssisted: MemoryExtractionSettings["allowToolAssisted"];
  }): Promise<MemoryExtractionSettings>;
}

export function createFileMemoryExtractionSettingsStore(
  options: {
    readonly pragmaHome?: string | undefined;
    readonly now?: (() => Date) | undefined;
  } = {},
): MemoryExtractionSettingsStore {
  const path = new PragmaPaths(options).memoryExtractionSettings();
  const now = options.now ?? (() => new Date());
  const initial = (): MemoryExtractionSettings =>
    MemoryExtractionSettingsSchema.parse({
      schemaVersion: "pragma.memory-extraction-settings/v1",
      revision: 0,
      allowToolAssisted: { episodic: false, semantic: false },
      updatedAt: new Date(0).toISOString(),
    });
  const read = async (): Promise<MemoryExtractionSettings> => {
    try {
      return MemoryExtractionSettingsSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isNotFound(error)) return initial();
      throw error;
    }
  };
  return {
    get: read,
    async update(input) {
      return await withFileLock(`${path}.lock`, async () => {
        const current = await read();
        if (current.revision !== input.expectedRevision) {
          const error = new Error("memory_extraction_settings_revision_conflict");
          Object.assign(error, { expected: input.expectedRevision, actual: current.revision });
          throw error;
        }
        const next = MemoryExtractionSettingsSchema.parse({
          schemaVersion: "pragma.memory-extraction-settings/v1",
          revision: current.revision + 1,
          allowToolAssisted: input.allowToolAssisted,
          updatedAt: now().toISOString(),
        });
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
        return next;
      });
    },
  };
}

export interface MemoryExtractionEvidenceSelection {
  readonly retained: readonly MemoryEvidenceEnvelope[];
  readonly omittedStats: MemoryEvidenceOmissionStats;
}

export function selectMemoryExtractionEvidence(
  evidence: readonly MemoryEvidenceEnvelope[],
  allowToolAssisted: boolean,
  module?: "episodic" | "semantic",
): MemoryExtractionEvidenceSelection {
  const retained: MemoryEvidenceEnvelope[] = [];
  const omitted: MemoryEvidenceEnvelope[] = [];
  for (const item of evidence) {
    const prepared = prepareExtractionEvidence(item, allowToolAssisted, module);
    if (prepared === undefined) omitted.push(item);
    else retained.push(prepared);
  }
  return {
    retained,
    omittedStats:
      omitted.length === 0
        ? EMPTY_MEMORY_EVIDENCE_OMISSION_STATS
        : summarizeMemoryEvidenceOmissions(omitted),
  };
}

function prepareExtractionEvidence(
  item: MemoryEvidenceEnvelope,
  allowToolAssisted: boolean,
  module?: "episodic" | "semantic",
): MemoryEvidenceEnvelope | undefined {
  if (item.schemaRef === "pragma.memory.tool-content/v1") {
    const content = MemoryToolContentPayloadSchema.safeParse(item.payload);
    return allowToolAssisted &&
      module !== undefined &&
      content.success &&
      content.data.allowedModules.includes(module)
      ? { ...item, payload: content.data }
      : undefined;
  }
  if (item.schemaRef === "pragma.memory.tool-event/v2") {
    const structural = MemorySafeToolEventPayloadSchema.safeParse(item.payload);
    return structural.success ? { ...item, payload: structural.data } : undefined;
  }
  if (item.schemaRef !== "pragma.memory.execution-message/v2") return item;
  const structural = MemorySafeExecutionMessagePayloadSchema.safeParse(item.payload);
  return structural.success ? { ...item, payload: structural.data } : undefined;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

/** Recheck consent before every delivery and before accepting a completed extraction. */
export function extractionEvidenceAccessGuard(
  evidence: readonly MemoryEvidenceEnvelope[],
  module: "episodic" | "semantic",
  settings: Pick<MemoryExtractionSettingsStore, "get"> | undefined,
): () => Promise<void> {
  const containsToolContent = evidence.some(
    (item) => item.schemaRef === "pragma.memory.tool-content/v1",
  );
  return async () => {
    if (containsToolContent && (await settings?.get())?.allowToolAssisted[module] !== true) {
      throw Object.assign(new Error("memory_curator_tool_content_denied"), { retryable: false });
    }
  };
}
