import { createHash, randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import { MemorySubjectRefSchema, type MemorySubjectRef } from "@pragma/shared";
import { z } from "zod";

export const MemoryCaptureDecisionSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-capture-activity/v1"),
    sourceEventId: z.string().min(1),
    executionId: z.string().min(1),
    outcome: z.enum(["published", "skipped", "failed"]),
    reason: z.string().min(1),
    occurredAt: z.string().datetime(),
  })
  .strict();

export const MemoryRecallActivitySchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-recall-activity/v1"),
    id: z.string().min(1),
    executionId: z.string().min(1),
    invocationId: z.string().min(1),
    operation: z.enum(["list", "search", "read"]),
    target: z.string().min(1),
    queryDigest: z.string().min(1).optional(),
    queryLength: z.number().int().nonnegative().optional(),
    resultRefs: z.array(
      z.object({ id: z.string().min(1), revision: z.string().min(1).optional() }).strict(),
    ),
    outcome: z.enum(["allowed", "denied", "failed"]),
    reason: z.string().min(1),
    occurredAt: z.string().datetime(),
  })
  .strict();

export const MemoryExecutionContextSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-execution-context/v1"),
    executionId: z.string().min(1),
    conversationRef: MemorySubjectRefSchema.optional(),
    principalRefs: z.array(MemorySubjectRefSchema),
    registeredAt: z.string().datetime(),
  })
  .strict();

export const MemoryExecutionActivitySummarySchema = z
  .object({
    executionId: z.string().min(1),
    capture: z.object({
      published: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    recall: z.object({
      list: z.number().int().nonnegative(),
      search: z.number().int().nonnegative(),
      read: z.number().int().nonnegative(),
      denied: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  })
  .strict();

export type MemoryCaptureDecision = z.infer<typeof MemoryCaptureDecisionSchema>;
export type MemoryRecallActivity = z.infer<typeof MemoryRecallActivitySchema>;
export type MemoryExecutionContext = z.infer<typeof MemoryExecutionContextSchema>;
export type MemoryExecutionActivitySummary = z.infer<typeof MemoryExecutionActivitySummarySchema>;

export interface MemoryActivityStore {
  registerExecutionContext(input: {
    readonly executionId: string;
    readonly conversationRef?: MemorySubjectRef | undefined;
    readonly principalRefs: readonly MemorySubjectRef[];
    readonly now?: Date | undefined;
  }): Promise<void>;
  getExecutionContext(executionId: string): Promise<MemoryExecutionContext | undefined>;
  recordCapture(input: MemoryCaptureDecision): Promise<void>;
  recordRecall(input: Omit<MemoryRecallActivity, "schemaVersion" | "id">): Promise<void>;
  summarize(executionId: string): Promise<MemoryExecutionActivitySummary>;
  listRecall(executionId: string): Promise<readonly MemoryRecallActivity[]>;
}

export function createMemoryActivityStore(options: {
  readonly pragmaHome?: string | undefined;
}): MemoryActivityStore {
  const paths = new PragmaPaths(options);

  const open = async (executionId: string): Promise<DatabaseSync> => {
    await mkdir(paths.memoryExecutionActivityRoot(executionId), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(paths.memoryExecutionActivity(executionId));
    initialize(database);
    return database;
  };

  const openExisting = async (executionId: string): Promise<DatabaseSync | undefined> => {
    const path = paths.memoryExecutionActivity(executionId);
    try {
      await access(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    const database = new DatabaseSync(path);
    initialize(database);
    return database;
  };

  return {
    async registerExecutionContext(input) {
      const context = MemoryExecutionContextSchema.parse({
        schemaVersion: "pragma.memory-execution-context/v1",
        executionId: input.executionId,
        ...(input.conversationRef === undefined ? {} : { conversationRef: input.conversationRef }),
        principalRefs: uniqueRefs(input.principalRefs),
        registeredAt: (input.now ?? new Date()).toISOString(),
      });
      const database = await open(input.executionId);
      try {
        database
          .prepare(
            "INSERT OR REPLACE INTO execution_context(singleton, context_json) VALUES (1, ?)",
          )
          .run(JSON.stringify(context));
      } finally {
        database.close();
      }
    },

    async getExecutionContext(executionId) {
      const database = await openExisting(executionId);
      if (database === undefined) return undefined;
      try {
        const row = database
          .prepare("SELECT context_json AS value FROM execution_context WHERE singleton = 1")
          .get() as { readonly value: string } | undefined;
        return row === undefined
          ? undefined
          : MemoryExecutionContextSchema.parse(JSON.parse(row.value));
      } finally {
        database.close();
      }
    },

    async recordCapture(input) {
      const decision = MemoryCaptureDecisionSchema.parse(input);
      const database = await open(decision.executionId);
      try {
        database
          .prepare("INSERT OR IGNORE INTO capture(source_event_id, activity_json) VALUES (?, ?)")
          .run(decision.sourceEventId, JSON.stringify(decision));
      } finally {
        database.close();
      }
    },

    async recordRecall(input) {
      const activity = MemoryRecallActivitySchema.parse({
        ...input,
        schemaVersion: "pragma.memory-recall-activity/v1",
        id: randomUUID(),
      });
      const database = await open(activity.executionId);
      try {
        database
          .prepare("INSERT INTO recall(id, occurred_at, activity_json) VALUES (?, ?, ?)")
          .run(activity.id, activity.occurredAt, JSON.stringify(activity));
      } finally {
        database.close();
      }
    },

    async summarize(executionId) {
      const database = await openExisting(executionId);
      if (database === undefined) return emptySummary(executionId);
      try {
        const capture = countByOutcome(database, "capture", "activity_json");
        const recalls = readRecallRows(database);
        return MemoryExecutionActivitySummarySchema.parse({
          executionId,
          capture: {
            published: capture.get("published") ?? 0,
            skipped: capture.get("skipped") ?? 0,
            failed: capture.get("failed") ?? 0,
          },
          recall: {
            list: recalls.filter((item) => item.operation === "list").length,
            search: recalls.filter((item) => item.operation === "search").length,
            read: recalls.filter((item) => item.operation === "read").length,
            denied: recalls.filter((item) => item.outcome === "denied").length,
            failed: recalls.filter((item) => item.outcome === "failed").length,
          },
        });
      } finally {
        database.close();
      }
    },

    async listRecall(executionId) {
      const database = await openExisting(executionId);
      if (database === undefined) return [];
      try {
        return readRecallRows(database);
      } finally {
        database.close();
      }
    },
  };
}

function emptySummary(executionId: string): MemoryExecutionActivitySummary {
  return MemoryExecutionActivitySummarySchema.parse({
    executionId,
    capture: { published: 0, skipped: 0, failed: 0 },
    recall: { list: 0, search: 0, read: 0, denied: 0, failed: 0 },
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

export function memoryQueryDigest(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function initialize(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get() as unknown as {
    readonly user_version: number;
  };
  if (version.user_version > 1) {
    database.close();
    throw new Error(`unsupported-state-version:pragma.memory-activity/v${version.user_version}`);
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS execution_context (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      context_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capture (
      source_event_id TEXT PRIMARY KEY,
      activity_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recall (
      id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      activity_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recall_occurred_at ON recall(occurred_at);
    PRAGMA user_version = 1;
  `);
}

function readRecallRows(database: DatabaseSync): readonly MemoryRecallActivity[] {
  return (
    database
      .prepare("SELECT activity_json AS value FROM recall ORDER BY occurred_at, id")
      .all() as unknown as readonly { readonly value: string }[]
  ).map((row) => MemoryRecallActivitySchema.parse(JSON.parse(row.value)));
}

function countByOutcome(
  database: DatabaseSync,
  table: "capture",
  column: "activity_json",
): Map<string, number> {
  return new Map(
    (
      database
        .prepare(
          `SELECT json_extract(${column}, '$.outcome') AS outcome, COUNT(*) AS count FROM ${table} GROUP BY outcome`,
        )
        .all() as unknown as readonly { readonly outcome: string; readonly count: number }[]
    ).map((row) => [row.outcome, row.count]),
  );
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): readonly MemorySubjectRef[] {
  return [
    ...new Map(
      refs.map((ref) => [`${ref.type}\0${ref.id}`, MemorySubjectRefSchema.parse(ref)]),
    ).values(),
  ];
}
