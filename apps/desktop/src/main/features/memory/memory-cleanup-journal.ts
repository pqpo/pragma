import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PragmaPaths, withFileLock, type CanonicalEventFeed } from "@pragma/core";
import {
  DEFAULT_MEMORY_STORAGE_POLICY,
  type EpisodicMemoryStore,
  type SemanticMemoryStore,
} from "@pragma/memory";
import { z } from "zod";

const CleanupJournalSchema = z.object({
  schemaVersion: z.literal("pragma.memory-cleanup-journal/v1"),
  id: z.string().min(1),
  executionIds: z.array(z.string().min(1)).min(1),
  completed: z.array(z.enum(["feed", "episodic", "semantic"])),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

type CleanupJournal = z.infer<typeof CleanupJournalSchema>;

export interface MemoryCleanupJournal {
  cleanup(executionIds: readonly string[]): Promise<void>;
  recover(): Promise<number>;
}

export function createMemoryCleanupJournal(options: {
  readonly pragmaHome: string;
  readonly feed: Pick<CanonicalEventFeed, "forgetCorrelation">;
  readonly episodic: Pick<EpisodicMemoryStore, "deleteExecutionState">;
  readonly semantic: Pick<SemanticMemoryStore, "deleteExecutionState">;
  readonly now?: (() => Date) | undefined;
}): MemoryCleanupJournal {
  const paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
  const root = paths.memoryCleanupJournalRoot();
  const now = options.now ?? (() => new Date());

  const replay = async (path: string, initial: CleanupJournal): Promise<void> => {
    let journal = initial;
    const complete = async (
      step: CleanupJournal["completed"][number],
      operation: () => Promise<void>,
    ): Promise<void> => {
      if (journal.completed.includes(step)) return;
      await operation();
      journal = CleanupJournalSchema.parse({
        ...journal,
        completed: [...journal.completed, step],
        updatedAt: now().toISOString(),
      });
      await writeJsonAtomic(path, journal);
    };
    await complete("feed", async () => {
      for (const executionId of journal.executionIds) {
        await options.feed.forgetCorrelation(executionId);
      }
    });
    await complete("episodic", async () => {
      await options.episodic.deleteExecutionState(journal.executionIds, now());
    });
    await complete("semantic", async () => {
      await options.semantic.deleteExecutionState(journal.executionIds, now());
    });
    await rm(path, { force: true });
  };

  return {
    async cleanup(executionIds) {
      const unique = [...new Set(executionIds)].toSorted();
      if (unique.length === 0) return;
      const id = createHash("sha256").update(JSON.stringify(unique)).digest("hex").slice(0, 24);
      const path = join(root, `${id}.json`);
      await withFileLock(`${path}.lock`, async () => {
        let journal: CleanupJournal;
        try {
          journal = CleanupJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
        } catch (error) {
          if (!isNotFound(error)) throw error;
          const timestamp = now().toISOString();
          journal = CleanupJournalSchema.parse({
            schemaVersion: "pragma.memory-cleanup-journal/v1",
            id,
            executionIds: unique,
            completed: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          await writeJsonAtomic(path, journal);
        }
        await replay(path, journal);
      });
    },

    async recover() {
      await removeStaleAtomicTemps(root, now());
      let names: string[];
      try {
        names = await readdir(root);
      } catch (error) {
        if (isNotFound(error)) return 0;
        throw error;
      }
      let recovered = 0;
      for (const name of names.filter((value) => value.endsWith(".json")).slice(0, 100)) {
        const path = join(root, name);
        await withFileLock(`${path}.lock`, async () => {
          let journal: CleanupJournal;
          try {
            journal = CleanupJournalSchema.parse(JSON.parse(await readFile(path, "utf8")));
          } catch (error) {
            if (isNotFound(error)) return;
            throw error;
          }
          await replay(path, journal);
          recovered += 1;
        });
      }
      return recovered;
    },
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeStaleAtomicTemps(root: string, now: Date): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  const cutoff = now.getTime() - DEFAULT_MEMORY_STORAGE_POLICY.atomicTempRetentionMs;
  for (const name of names.filter((value) => value.endsWith(".tmp"))) {
    const path = join(root, name);
    try {
      if ((await stat(path)).mtimeMs <= cutoff) await rm(path, { force: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
