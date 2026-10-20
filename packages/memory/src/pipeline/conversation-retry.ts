import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { PragmaPaths, withFileLock } from "@pragma/core";
import { z } from "zod";
import type { EpisodicMemoryStore } from "../episodic/store.ts";
import type { SemanticMemoryStore } from "../semantic/store.ts";
import { createMemoryExtractionSessionStore } from "./extraction-session.ts";

const RetryMemberSchema = z
  .object({
    module: z.enum(["episodic", "semantic"]),
    id: z.string().min(1),
    revision: z.number().int().positive(),
    watermark: z.string().min(1),
  })
  .strict();
const RetryJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-conversation-retry/v1"),
    jobId: z.string().min(1),
    restart: z.boolean(),
    members: z.array(RetryMemberSchema).min(1).max(2),
    generations: z.record(z.string(), z.number().int().nonnegative()),
    createdAt: z.string().datetime(),
  })
  .strict();
type RetryJournal = z.infer<typeof RetryJournalSchema>;
type RetryStores = {
  pragmaHome: string;
  episodic: Pick<EpisodicMemoryStore, "getExtractionJob" | "retryJob">;
  semantic: Pick<SemanticMemoryStore, "getExtractionJob" | "retryJob">;
};
function journalPath(options: { pragmaHome: string }): string {
  return join(new PragmaPaths(options).memoryStateRoot(), "conversation-retry-v1.json");
}
async function readJournal(options: RetryStores): Promise<RetryJournal | undefined> {
  try {
    return RetryJournalSchema.parse(JSON.parse(await readFile(journalPath(options), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await rm(`${journalPath(options)}.tmp`, { force: true });
      return undefined;
    }
    throw error;
  }
}

/** Called under the conversation admission lock, before any new claim can run. */
export async function replayConversationMemoryRetry(options: RetryStores): Promise<void> {
  const journal = await readJournal(options);
  if (journal === undefined) return;
  const sessions = createMemoryExtractionSessionStore(options);
  await sessions.retryConversation(
    journal.jobId,
    journal.restart,
    journal.members.map(({ module }) => module),
    journal.generations,
  );
  for (const member of journal.members) {
    const store = options[member.module];
    const job = await store.getExtractionJob(member.id);
    // New source work or deletion supersedes this delivery; never retry a new snapshot.
    if (job === undefined || job.inputWatermark !== member.watermark) continue;
    // Any newer transition supersedes this intent, including lifecycle touches and
    // later cancellation/failure. Never reset newer state during journal recovery.
    if (job.revision > member.revision) continue;
    if (job.revision < member.revision)
      throw new Error("memory_extraction_retry_recovery_conflict");
    if (journal.restart) await sessions.deleteJobs(member.module, [member.id]);
    await store.retryJob({
      id: member.id,
      expectedRevision: member.revision,
      now: new Date(journal.createdAt),
      preserveSession: true,
    });
  }
  await rm(journalPath(options));
}

/** One bounded journal spans Session and both delivery databases. */
export function createConversationMemoryRetryManager(options: RetryStores) {
  const paths = new PragmaPaths(options);
  const locked = <T>(operation: () => Promise<T>) =>
    withFileLock(join(paths.memoryStateRoot(), "conversation-extraction.lock"), operation);
  return {
    recover: () => locked(() => replayConversationMemoryRetry(options)),
    retry: (input: {
      jobId: string;
      restart: boolean;
      members: readonly z.infer<typeof RetryMemberSchema>[];
    }) =>
      locked(async () => {
        await replayConversationMemoryRetry(options);
        for (const member of input.members) {
          const job = await options[member.module].getExtractionJob(member.id);
          if (
            job?.revision !== member.revision ||
            job.inputWatermark !== member.watermark ||
            job.status !== "needs_attention"
          )
            throw new Error("memory_extraction_job_revision_conflict");
        }
        const journal = RetryJournalSchema.parse({
          schemaVersion: "pragma.memory-conversation-retry/v1",
          ...input,
          generations: await createMemoryExtractionSessionStore(
            options,
          ).conversationRetryGenerations(input.jobId),
          createdAt: new Date().toISOString(),
        });
        const path = journalPath(options);
        // Admission is serialized; one fixed staging file also bounds crash leftovers.
        const temporary = `${path}.tmp`;
        await mkdir(paths.memoryStateRoot(), { recursive: true, mode: 0o700 });
        try {
          const file = await open(temporary, "w", 0o600);
          try {
            await file.writeFile(JSON.stringify(journal));
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        await replayConversationMemoryRetry(options);
      }),
  };
}
