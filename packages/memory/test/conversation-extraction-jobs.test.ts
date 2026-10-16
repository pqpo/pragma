import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { expect, it, vi } from "vitest";
import { createEpisodicMemoryStore } from "../src/episodic/store.ts";
import { createSemanticMemoryStore } from "../src/semantic/store.ts";
import { EpisodicExtractionJobSchema } from "../src/episodic/schema.ts";
import { SemanticExtractionJobSchema } from "../src/semantic/schema.ts";
import { createConversationExtractionJobReader } from "../src/pipeline/conversation-extraction-jobs.ts";

it("aggregates and keyset-pages a large task catalog without parsing jobs outside the requested page", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-conversation-page-"));
  const episodic = await createEpisodicMemoryStore({ pragmaHome });
  const semantic = await createSemanticMemoryStore({ pragmaHome });
  const paths = new PragmaPaths({ pragmaHome });
  const count = 3000;
  const timestamp = "2026-10-16T00:00:00.000Z";
  try {
    for (const type of ["episodic", "semantic"] as const) {
      const db = new DatabaseSync(
        join(paths.memoryModuleStateRoot(`pragma.memory.${type}`), "jobs.sqlite"),
      );
      try {
        db.exec("BEGIN");
        const insert = db.prepare(
          "INSERT INTO jobs(id,conversation_key,execution_id,terminal_message_id,status,job_json) VALUES(?,?,?,?,?,?)",
        );
        for (let index = 0; index < count; index++) {
          const status =
            index % 3 === 0
              ? "completed"
              : index % 3 === 1
                ? type === "episodic"
                  ? "completed"
                  : "needs_attention"
                : "running";
          const job = {
            schemaVersion:
              type === "episodic"
                ? "pragma.memory-extraction-job/v4"
                : "pragma.memory-semantic-job/v4",
            id: `${type}-${index}`,
            revision: type === "episodic" ? 1 : 2,
            conversationRef: { type: "pragma.mission", id: `mission-${index}` },
            sourceExecutionIds: [`execution-${index}`],
            sourceUpdatedAt: timestamp,
            inputWatermark: `watermark-${index}`,
            executionId: `execution-${index}`,
            terminalMessageId: `terminal-${index}`,
            status,
            attempts: 0,
            totalAttempts: 0,
            updatedAt: timestamp,
            ...(status === "completed"
              ? { completion: type === "episodic" ? "retained" : "rejected" }
              : {}),
          };
          (type === "episodic" ? EpisodicExtractionJobSchema : SemanticExtractionJobSchema).parse(
            job,
          );
          insert.run(
            job.id,
            `mission-${index}`,
            job.executionId,
            job.terminalMessageId,
            status,
            JSON.stringify(job),
          );
        }
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    }
    const episodeParses = vi.spyOn(EpisodicExtractionJobSchema, "parse");
    const factParses = vi.spyOn(SemanticExtractionJobSchema, "parse");
    try {
      const reader = createConversationExtractionJobReader({ pragmaHome });
      const started = performance.now();
      const first = await reader.listJobsPage({
        statuses: ["completed"],
        sortKeyPrefix: "conversation",
        limit: 10,
      });
      const elapsed = performance.now() - started;
      expect(first.total).toBe(count / 3);
      expect(first.jobs).toHaveLength(10);
      expect(episodeParses).toHaveBeenCalledTimes(10);
      expect(factParses).toHaveBeenCalledTimes(10);
      expect(
        first.jobs.every(
          (task) =>
            task.members.length === 2 &&
            task.job.revision === 3 &&
            task.job.completion === "retained",
        ),
      ).toBe(true);
      const last = first.jobs.at(-1)!;
      const second = await reader.listJobsPage({
        statuses: ["completed"],
        sortKeyPrefix: "conversation",
        limit: 10,
        before: { updatedAt: last.job.updatedAt, tieBreaker: `conversation:${last.job.id}` },
      });
      expect(second.jobs).toHaveLength(10);
      expect(
        second.jobs.every((task) => !first.jobs.some((prior) => prior.job.id === task.job.id)),
      ).toBe(true);
      const attention = await reader.listJobsPage({
        statuses: ["attention"],
        sortKeyPrefix: "conversation",
        limit: 10,
      });
      expect(attention.total).toBe(count / 3);
      expect(
        attention.jobs.every(
          (task) =>
            task.lane === "attention" &&
            task.members.some((member) => member.job.status === "completed"),
        ),
      ).toBe(true);
      episodeParses.mockClear();
      factParses.mockClear();
      expect(await reader.getTask(last.job.id)).toEqual(last);
      expect(episodeParses).toHaveBeenCalledTimes(1);
      expect(factParses).toHaveBeenCalledTimes(1);
      expect(await reader.getTask("missing-task")).toBeUndefined();
      expect(elapsed).toBeLessThan(5000);
      console.info(
        `Conversation task page: ${count * 2} source jobs, ${first.jobs.length} tasks, 20 parsed jobs, ${elapsed.toFixed(1)}ms`,
      );
    } finally {
      episodeParses.mockRestore();
      factParses.mockRestore();
    }
  } finally {
    episodic.close();
    semantic.close();
    await rm(pragmaHome, { recursive: true, force: true });
  }
});
