import type { DatabaseSync } from "node:sqlite";

export interface MemoryJobPageInput<TStatus extends string> {
  readonly statuses: readonly TStatus[];
  readonly limit: number;
  readonly sortKeyPrefix: string;
  readonly before?:
    | {
        readonly updatedAt: string;
        readonly tieBreaker: string;
      }
    | undefined;
}

export interface MemoryJobPage<TJob> {
  readonly jobs: readonly TJob[];
  readonly total: number;
}

export function queryMemoryJobPage<TJob, TStatus extends string>(
  database: DatabaseSync,
  input: MemoryJobPageInput<TStatus>,
  parseJob: (json: string) => TJob,
): MemoryJobPage<TJob> {
  if (input.statuses.length === 0) throw new Error("Memory job page requires a status filter.");
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new Error("Memory job page limit must be a positive safe integer.");
  }
  if (input.sortKeyPrefix.length === 0) {
    throw new Error("Memory job page sort key prefix must not be empty.");
  }

  const placeholders = input.statuses.map(() => "?").join(", ");
  const totalRow = database
    .prepare(`SELECT COUNT(*) AS total FROM jobs WHERE status IN (${placeholders})`)
    .get(...input.statuses) as { readonly total: number };
  const cursorClause =
    input.before === undefined
      ? ""
      : ` AND (
          json_extract(job_json, '$.updatedAt') < ? OR
          (json_extract(job_json, '$.updatedAt') = ? AND (? || ':' || id) < ?)
        )`;
  const parameters =
    input.before === undefined
      ? [...input.statuses, input.limit]
      : [
          ...input.statuses,
          input.before.updatedAt,
          input.before.updatedAt,
          input.sortKeyPrefix,
          input.before.tieBreaker,
          input.limit,
        ];
  const rows = database
    .prepare(
      `SELECT job_json AS jobJson FROM jobs
       WHERE status IN (${placeholders})${cursorClause}
       ORDER BY json_extract(job_json, '$.updatedAt') DESC, id DESC
       LIMIT ?`,
    )
    .all(...parameters) as unknown as readonly {
    readonly jobJson: string;
  }[];

  return {
    jobs: rows.map((row) => parseJob(row.jobJson)),
    total: Number(totalRow.total),
  };
}
