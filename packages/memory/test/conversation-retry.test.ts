import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createEpisodicMemoryModule,
  createSemanticMemoryModule,
  createMemoryExtractionSessionStore,
  createConversationMemoryRetryManager,
  conversationExtractionJobId,
  ConversationExtractionInputSchema,
  createConversationMemoryExtractionCoordinator,
} from "../src/index.ts";
import { extractionInput } from "./support/extraction.ts";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(
  [
    "before-first",
    "after-first",
    "before-second",
    "after-second",
    "lifecycle-before-second",
    "new-failure-before-second",
  ].flatMap((failure) => [false, true].map((restart) => ({ failure, restart }))),
)(
  "replays $failure (restart=$restart) without resetting the Session twice",
  async ({ failure, restart }) => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-retry-journal-"));
    roots.push(pragmaHome);
    const episodic = await createEpisodicMemoryModule({ pragmaHome });
    const semantic = await createSemanticMemoryModule({ pragmaHome });
    const options = { pragmaHome, episodic: episodic.store, semantic: semantic.store };
    const due = new Date(Date.now() + 7 * 60 * 60 * 1000);
    try {
      const message = extractionInput().evidence[0]!;
      for (const store of [episodic.store, semantic.store]) {
        await store.ingest([
          message,
          {
            ...message,
            messageId: "terminal",
            topic: "execution.execution.terminal",
            schemaRef: "pragma.memory.execution-terminal/v2",
            payload: { outcome: "succeeded" },
          },
        ]);
      }
      const failureMetadata = {
        now: due,
        retry: "configuration" as const,
        diagnostic: {
          schemaVersion: "pragma.memory-extraction-failure/v1" as const,
          code: "injected_failure",
          message: "Injected failure",
          phase: "curator_run" as const,
          failedAt: due.toISOString(),
          retryable: false,
        },
      };
      await episodic.store.fail({
        job: (await episodic.store.claimDueJob(due))!,
        ...failureMetadata,
      });
      await semantic.store.fail({
        job: (await semantic.store.claimDueJob(due))!,
        ...failureMetadata,
      });
      const episode = (await episodic.store.listExtractionJobs())[0]!;
      const fact = (await semantic.store.listExtractionJobs())[0]!;
      const jobId = conversationExtractionJobId(episode.conversationRef, episode.inputWatermark);
      const sessions = createMemoryExtractionSessionStore({ pragmaHome });
      const session = await sessions.create({
        module: "conversation",
        watermark: "combined",
        input: ConversationExtractionInputSchema.parse({
          ...extractionInput(),
          jobId,
          schemaVersion: "pragma.memory-conversation-extraction-input/v1",
          targets: ["episodic", "semantic"],
          evidenceTypes: { message: ["episodic", "semantic"] },
          jobs: {
            episodic: { jobId: episode.id, watermark: episode.inputWatermark },
            semantic: { jobId: fact.id, watermark: fact.inputWatermark },
          },
        }),
      });
      const target = failure.endsWith("first") ? episodic.store : semantic.store;
      const original = target.retryJob.bind(target);
      vi.spyOn(target, "retryJob").mockImplementationOnce(async (input) => {
        if (failure.startsWith("after")) await original(input);
        throw new Error("injected write failure");
      });
      await expect(
        createConversationMemoryRetryManager(options).retry({
          jobId,
          restart,
          members: [
            {
              module: "episodic",
              id: episode.id,
              revision: episode.revision,
              watermark: episode.inputWatermark,
            },
            {
              module: "semantic",
              id: fact.id,
              revision: fact.revision,
              watermark: fact.inputWatermark,
            },
          ],
        }),
      ).rejects.toThrow("injected write failure");
      vi.restoreAllMocks();
      if (failure === "lifecycle-before-second") {
        await episodic.setConversationState({
          conversationRef: episode.conversationRef,
          state: "completed",
          now: due,
        });
      }
      if (failure === "new-failure-before-second") {
        await episodic.store.fail({
          job: (await episodic.store.claimDueJob(due))!,
          ...failureMetadata,
        });
      }
      // Reopening the coordinator recovers management before looking for eligible work.
      const prepareEpisode = vi.fn(async () => undefined);
      const prepareFact = vi.fn(async () => undefined);
      const coordinator = createConversationMemoryExtractionCoordinator({
        pragmaHome,
        now: () => due,
        episodic: { store: episodic.store, prepareBackgroundOnce: prepareEpisode },
        semantic: { store: semantic.store, prepareBackgroundOnce: prepareFact },
      });
      coordinator.setExtractor({
        extract: async () => {
          throw new Error("Unexpected admission");
        },
      });
      await coordinator.runOnce();
      expect(prepareEpisode).toHaveBeenCalledTimes(failure === "new-failure-before-second" ? 0 : 1);
      expect(prepareFact).toHaveBeenCalledTimes(failure === "new-failure-before-second" ? 0 : 1);
      expect((await episodic.store.getExtractionJob(episode.id))?.status).toBe(
        failure === "new-failure-before-second" ? "needs_attention" : "pending",
      );
      expect((await semantic.store.getExtractionJob(fact.id))?.status).toBe("pending");
      expect((await sessions.conversationRetryGenerations(jobId))[session.key]).toBe(1);
      await expect(
        readFile(join(pragmaHome, "state/memory/conversation-retry-v1.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await createConversationMemoryRetryManager(options).recover();
      expect((await sessions.conversationRetryGenerations(jobId))[session.key]).toBe(1);
      const path = join(pragmaHome, "state/memory/conversation-retry-v1.json");
      await writeFile(
        path,
        JSON.stringify({ schemaVersion: "pragma.memory-conversation-retry/v99" }),
      );
      await expect(createConversationMemoryRetryManager(options).recover()).rejects.toThrow();
      expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toContain("v99");
    } finally {
      episodic.close();
      semantic.close();
    }
  },
);
