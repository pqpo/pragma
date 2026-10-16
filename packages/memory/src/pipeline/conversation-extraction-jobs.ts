import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { PragmaPaths } from "@pragma/core";
import { conversationExtractionJobId } from "./conversation-extraction.ts";
import { EpisodicExtractionJobSchema, type EpisodicExtractionJob } from "../episodic/schema.ts";
import { SemanticExtractionJobSchema, type SemanticExtractionJob } from "../semantic/schema.ts";
import type { MemoryJobPage, MemoryJobPageInput } from "./memory-job-page.ts";
export type ConversationExtractionLane = "waiting" | "attention" | "running" | "completed";
type ConversationExtractionJob = EpisodicExtractionJob | SemanticExtractionJob;
export interface ConversationExtractionTask {
  readonly module: "conversation";
  readonly lane: ConversationExtractionLane;
  readonly job: ConversationExtractionJob;
  readonly members: readonly {
    readonly module: "episodic" | "semantic";
    readonly job: ConversationExtractionJob;
  }[];
}
function laneForStatus(status: ConversationExtractionJob["status"]): ConversationExtractionLane {
  return status === "running"
    ? "running"
    : status === "needs_attention"
      ? "attention"
      : status === "completed" || status === "expired"
        ? "completed"
        : "waiting";
}
export function groupConversationExtractionJobs(
  episodic: readonly EpisodicExtractionJob[],
  semantic: readonly SemanticExtractionJob[],
): ConversationExtractionTask[] {
  const groups = new Map<
    string,
    { module: "episodic" | "semantic"; job: ConversationExtractionJob }[]
  >();
  for (const [module, jobs] of [
    ["episodic", episodic],
    ["semantic", semantic],
  ] as const) {
    for (const job of jobs) {
      if (job.status === "expired") continue;
      const id = conversationExtractionJobId(job.conversationRef, job.inputWatermark);
      const members = groups.get(id) ?? [];
      members.push({ module, job });
      groups.set(id, members);
    }
  }
  const rank = { completed: 0, waiting: 1, running: 3, attention: 2 };
  return [...groups].map(([id, members]) => {
    const representative = members.toSorted(
      (a, b) => rank[laneForStatus(b.job.status)] - rank[laneForStatus(a.job.status)],
    )[0]!.job;
    const lane = laneForStatus(representative.status);
    return {
      module: "conversation",
      lane,
      members,
      job: {
        ...representative,
        id,
        revision: members.reduce((total, member) => total + member.job.revision, 0),
        updatedAt: members
          .map(({ job }) => job.updatedAt)
          .toSorted()
          .at(-1)!,
        ...(lane === "completed"
          ? {
              completion: members.some(({ job }) => job.completion === "retained")
                ? "retained"
                : "rejected",
            }
          : {}),
      },
    };
  });
}

/** Read-time aggregate over the two authoritative delivery stores. Only selected page members
 * cross the SQLite boundary; no second persistent task authority or startup catalog scan. */
export function createConversationExtractionJobReader(options: { pragmaHome: string }) {
  const paths = new PragmaPaths(options);
  return {
    async listJobsPage(
      input: MemoryJobPageInput<ConversationExtractionLane> & { readonly taskId?: string },
    ): Promise<MemoryJobPage<ConversationExtractionTask>> {
      if (
        input.statuses.length === 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new Error("memory_extraction_page_invalid");
      const db = new DatabaseSync(
        join(paths.memoryModuleStateRoot("pragma.memory.episodic"), "jobs.sqlite"),
        { readOnly: true },
      );
      try {
        db.prepare("ATTACH DATABASE ? AS semantic").run(
          join(paths.memoryModuleStateRoot("pragma.memory.semantic"), "jobs.sqlite"),
        );
        db.exec("PRAGMA query_only = ON; BEGIN");
        db.function("conversation_task_id", { deterministic: true }, (type, id, watermark) =>
          conversationExtractionJobId({ type: String(type), id: String(id) }, String(watermark)),
        );
        const source = `WITH members AS (
          SELECT conversation_key, json_extract(job_json,'$.inputWatermark') AS watermark,
            json_extract(job_json,'$.conversationRef.type') AS ref_type, json_extract(job_json,'$.conversationRef.id') AS ref_id,
            json_extract(job_json,'$.updatedAt') AS updated_at,
            CASE status WHEN 'running' THEN 3 WHEN 'needs_attention' THEN 2 WHEN 'completed' THEN 0 ELSE 1 END AS rank
            FROM main.jobs WHERE status <> 'expired'
          UNION ALL SELECT conversation_key, json_extract(job_json,'$.inputWatermark'),
            json_extract(job_json,'$.conversationRef.type'), json_extract(job_json,'$.conversationRef.id'),
            json_extract(job_json,'$.updatedAt'), CASE status WHEN 'running' THEN 3 WHEN 'needs_attention' THEN 2 WHEN 'completed' THEN 0 ELSE 1 END
            FROM semantic.jobs WHERE status <> 'expired'
        ), grouped AS (SELECT conversation_key, watermark, ref_type, ref_id, max(updated_at) AS updated_at,
          CASE max(rank) WHEN 3 THEN 'running' WHEN 2 THEN 'attention' WHEN 0 THEN 'completed' ELSE 'waiting' END AS lane
          FROM members GROUP BY conversation_key, watermark)`;
        const taskId = "conversation_task_id(ref_type,ref_id,watermark)";
        const lanes = input.statuses.map(() => "?").join(",");
        const taskFilter = input.taskId === undefined ? "" : `AND ${taskId} = ?`;
        const taskParameters = input.taskId === undefined ? [] : [input.taskId];
        const total = (
          db
            .prepare(
              `${source} SELECT count(*) AS total FROM grouped WHERE lane IN (${lanes}) ${taskFilter}`,
            )
            .get(...input.statuses, ...taskParameters) as { total: number }
        ).total;
        const before = input.before;
        const rows = db
          .prepare(
            `${source}, selected AS MATERIALIZED (
          SELECT conversation_key,watermark,updated_at,${taskId} AS task_id FROM grouped WHERE lane IN (${lanes}) ${taskFilter}
          ${before === undefined ? "" : `AND (updated_at < ? OR (updated_at = ? AND ('conversation:' || ${taskId}) < ?))`}
          ORDER BY updated_at DESC, task_id DESC LIMIT ?
        )
          SELECT 'episodic' AS module, job.job_json AS jobJson, selected.updated_at, selected.task_id
            FROM selected JOIN main.jobs AS job ON job.conversation_key = selected.conversation_key
            WHERE json_extract(job.job_json,'$.inputWatermark') = selected.watermark
          UNION ALL SELECT 'semantic', job.job_json, selected.updated_at, selected.task_id
            FROM selected JOIN semantic.jobs AS job ON job.conversation_key = selected.conversation_key
            WHERE json_extract(job.job_json,'$.inputWatermark') = selected.watermark
          ORDER BY updated_at DESC, task_id DESC, module`,
          )
          .all(
            ...input.statuses,
            ...taskParameters,
            ...(before === undefined
              ? []
              : [before.updatedAt, before.updatedAt, before.tieBreaker]),
            input.limit,
          ) as { module: string; jobJson: string }[];
        const episodes: EpisodicExtractionJob[] = [],
          facts: SemanticExtractionJob[] = [];
        for (const row of rows) {
          if (row.module === "episodic")
            episodes.push(EpisodicExtractionJobSchema.parse(JSON.parse(row.jobJson)));
          else facts.push(SemanticExtractionJobSchema.parse(JSON.parse(row.jobJson)));
        }
        db.exec("COMMIT");
        return {
          total,
          jobs: groupConversationExtractionJobs(episodes, facts).toSorted(
            (a, b) =>
              b.job.updatedAt.localeCompare(a.job.updatedAt) || b.job.id.localeCompare(a.job.id),
          ),
        };
      } finally {
        db.close();
      }
    },
    async getTask(id: string): Promise<ConversationExtractionTask | undefined> {
      return (
        await this.listJobsPage({
          statuses: ["waiting", "attention", "running", "completed"],
          sortKeyPrefix: "conversation",
          limit: 1,
          taskId: id,
        })
      ).jobs[0];
    },
  };
}
