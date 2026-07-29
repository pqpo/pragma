import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Invocation } from "@pragma/shared";
import type { RuntimeUsageObservation } from "@pragma/core";

import type {
  MissionUsage,
  UsageOverview,
  UsagePeriod,
  UsageSubjectKind,
  UsageSubjectList,
  UsageTokenTotals,
  UsageUpdate,
} from "../../../shared/contracts/index.ts";

const EMPTY_USAGE: UsageTokenTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};
const USAGE_SCHEMA_VERSION = "pragma.desktop-usage/v1";

export interface UsageObservationContext {
  readonly mission: { readonly id: string; readonly title: string };
  readonly invocations: readonly Invocation[];
  readonly names: ReadonlyMap<string, string>;
}

export interface DesktopUsageStore {
  readonly trackingStartedAt: string;
  readonly preview: (
    observation: RuntimeUsageObservation,
    context: UsageObservationContext,
  ) => void;
  readonly record: (observation: RuntimeUsageObservation, context: UsageObservationContext) => void;
  readonly clearPreview: (observationId: string) => void;
  readonly recordRecovered: (
    observation: Omit<RuntimeUsageObservation, "observationId" | "runId">,
    context: UsageObservationContext,
  ) => void;
  readonly getOverview: (period: UsagePeriod) => UsageOverview;
  readonly listSubjects: (input: {
    readonly period: UsagePeriod;
    readonly kind: UsageSubjectKind;
    readonly offset: number;
    readonly limit: number;
  }) => UsageSubjectList;
  /** Returns persisted totals only; `provisional` indicates whether live previews exist. */
  readonly getMissionUsage: (missionId: string) => MissionUsage;
  readonly markMissionDeleted: (missionId: string) => void;
  readonly subscribe: (listener: (update: UsageUpdate) => void) => () => void;
  readonly close: () => void;
}

export async function createDesktopUsageStore(input: {
  readonly databasePath: string;
  readonly now?: Date | undefined;
  readonly timezone?: string | undefined;
}): Promise<DesktopUsageStore> {
  await mkdir(dirname(input.databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(input.databasePath);
  const existingMetadataTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_metadata'")
    .get();
  if (existingMetadataTable !== undefined) {
    const existingVersion = database
      .prepare("SELECT value FROM usage_metadata WHERE key = 'schemaVersion'")
      .get() as { value?: unknown } | undefined;
    if (existingVersion?.value !== USAGE_SCHEMA_VERSION) {
      database.close();
      throw new Error(`Unsupported Desktop usage schema: ${String(existingVersion?.value)}.`);
    }
  }
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS usage_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_observations (
      observation_id TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      local_date TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      model_provider_id TEXT,
      model_id TEXT,
      input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL CHECK(cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL CHECK(cache_write_tokens >= 0),
      total_tokens INTEGER NOT NULL CHECK(total_tokens >= 0)
    );
    CREATE INDEX IF NOT EXISTS usage_observations_occurred_at
      ON usage_observations(occurred_at);
    CREATE INDEX IF NOT EXISTS usage_observations_mission
      ON usage_observations(mission_id, occurred_at);
    CREATE TABLE IF NOT EXISTS usage_subjects (
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      name TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(kind, subject_id)
    );
    CREATE TABLE IF NOT EXISTS usage_attributions (
      observation_id TEXT NOT NULL REFERENCES usage_observations(observation_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY(observation_id, kind, subject_id)
    );
    CREATE INDEX IF NOT EXISTS usage_attributions_subject
      ON usage_attributions(kind, subject_id, observation_id);
  `);
  const currentTime = (): Date => input.now ?? new Date();
  const now = currentTime().toISOString();
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const insertMetadata = database.prepare(
    "INSERT OR IGNORE INTO usage_metadata(key, value) VALUES (?, ?)",
  );
  insertMetadata.run("schemaVersion", USAGE_SCHEMA_VERSION);
  insertMetadata.run("trackingStartedAt", now);
  insertMetadata.run("timezone", timezone);
  insertMetadata.run("revision", "0");
  await chmod(input.databasePath, 0o600);
  const metadata = (key: string): string => {
    const row = database.prepare("SELECT value FROM usage_metadata WHERE key = ?").get(key) as
      | { value?: unknown }
      | undefined;
    if (typeof row?.value !== "string") throw new Error(`Usage metadata is missing: ${key}.`);
    return row.value;
  };
  const trackingStartedAt = metadata("trackingStartedAt");
  const storedTimezone = metadata("timezone");
  const schemaVersion = metadata("schemaVersion");
  if (schemaVersion !== USAGE_SCHEMA_VERSION) {
    database.close();
    throw new Error(`Unsupported Desktop usage schema: ${schemaVersion}.`);
  }
  const listeners = new Set<(update: UsageUpdate) => void>();
  const previews = new Map<
    string,
    {
      readonly observation: RuntimeUsageObservation;
      readonly context: UsageObservationContext;
    }
  >();
  let currentRevision = Number(metadata("revision"));
  const persistedMissionTotals = (missionId: string): UsageTokenTotals =>
    readTotals(
      database
        .prepare(
          `SELECT
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
            COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
            COALESCE(SUM(total_tokens), 0) AS totalTokens
           FROM usage_observations WHERE mission_id = ?`,
        )
        .get(missionId),
    );
  const missionPreviewTotals = (missionId: string): UsageTokenTotals =>
    [...previews.values()]
      .filter((preview) => preview.context.mission.id === missionId)
      .reduce((total, preview) => addTotals(total, preview.observation.usage), { ...EMPTY_USAGE });
  const missionTotals = (missionId: string): UsageTokenTotals =>
    addTotals(persistedMissionTotals(missionId), missionPreviewTotals(missionId));
  const publish = (missionId?: string, provisional = false, persist = true): void => {
    currentRevision += 1;
    if (persist) {
      database
        .prepare("UPDATE usage_metadata SET value = ? WHERE key = 'revision'")
        .run(String(currentRevision));
    }
    const update: UsageUpdate = {
      revision: currentRevision,
      ...(missionId === undefined
        ? {}
        : {
            missionId,
            missionUsage: missionTotals(missionId),
            provisional,
          }),
    };
    for (const listener of listeners) listener(update);
  };

  const store: DesktopUsageStore = {
    trackingStartedAt,
    preview(observation, context) {
      if (observation.occurredAt < trackingStartedAt) return;
      const persisted = database
        .prepare("SELECT signature FROM usage_observations WHERE observation_id = ?")
        .get(observation.observationId);
      if (persisted !== undefined) return;
      const existing = previews.get(observation.observationId);
      if (
        existing !== undefined &&
        observationSignature(existing.observation) === observationSignature(observation)
      ) {
        return;
      }
      previews.set(observation.observationId, { observation, context });
      publish(context.mission.id, true, false);
    },
    record(observation, context) {
      if (observation.occurredAt < trackingStartedAt) {
        store.clearPreview(observation.observationId);
        return;
      }
      const signature = observationSignature(observation);
      const existing = database
        .prepare("SELECT signature FROM usage_observations WHERE observation_id = ?")
        .get(observation.observationId) as { signature?: unknown } | undefined;
      if (existing !== undefined) {
        if (existing.signature === signature) {
          const preview = previews.get(observation.observationId);
          previews.delete(observation.observationId);
          if (preview !== undefined) publish(preview.context.mission.id);
          return;
        }
        throw new Error(`Conflicting usage observation: ${observation.observationId}.`);
      }
      const subjects = resolveSubjects(observation, context);
      database.exec("BEGIN IMMEDIATE;");
      try {
        database
          .prepare(
            `INSERT INTO usage_observations(
              observation_id, signature, occurred_at, local_date, mission_id,
              execution_id, invocation_id, run_id, runtime_id, model_provider_id, model_id,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            observation.observationId,
            signature,
            observation.occurredAt,
            localDate(observation.occurredAt, storedTimezone),
            context.mission.id,
            observation.executionId,
            observation.invocationId,
            observation.runId,
            observation.runtimeId,
            observation.modelSelection?.model.providerId ?? null,
            observation.modelSelection?.model.modelId ?? null,
            observation.usage.input,
            observation.usage.output,
            observation.usage.cacheRead,
            observation.usage.cacheWrite,
            observation.usage.totalTokens,
          );
        const upsertSubject = database.prepare(
          `INSERT INTO usage_subjects(kind, subject_id, name, deleted, last_seen_at)
           VALUES (?, ?, ?, 0, ?)
           ON CONFLICT(kind, subject_id) DO UPDATE SET
             name = CASE WHEN usage_subjects.deleted = 1 THEN usage_subjects.name ELSE excluded.name END,
             last_seen_at = excluded.last_seen_at`,
        );
        const insertAttribution = database.prepare(
          `INSERT INTO usage_attributions(observation_id, kind, subject_id, relation)
           VALUES (?, ?, ?, ?)`,
        );
        for (const subject of subjects) {
          upsertSubject.run(subject.kind, subject.id, subject.name, observation.occurredAt);
          insertAttribution.run(
            observation.observationId,
            subject.kind,
            subject.id,
            subject.relation,
          );
        }
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      previews.delete(observation.observationId);
      publish(context.mission.id);
    },
    clearPreview(observationId) {
      const preview = previews.get(observationId);
      if (preview === undefined) return;
      previews.delete(observationId);
      publish(
        preview.context.mission.id,
        [...previews.values()].some(
          (candidate) => candidate.context.mission.id === preview.context.mission.id,
        ),
        false,
      );
    },
    recordRecovered(observation, context) {
      const recorded = readTotals(
        database
          .prepare(
            `SELECT
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
              COALESCE(SUM(total_tokens), 0) AS totalTokens
             FROM usage_observations
             WHERE execution_id = ? AND invocation_id = ?`,
          )
          .get(observation.executionId, observation.invocationId),
      );
      const recovered = {
        input: Math.max(observation.usage.input - recorded.input, 0),
        output: Math.max(observation.usage.output - recorded.output, 0),
        cacheRead: Math.max(observation.usage.cacheRead - recorded.cacheRead, 0),
        cacheWrite: Math.max(observation.usage.cacheWrite - recorded.cacheWrite, 0),
      };
      const totalTokens =
        recovered.input + recovered.output + recovered.cacheRead + recovered.cacheWrite;
      if (totalTokens === 0) return;
      store.record(
        {
          ...observation,
          observationId: createHash("sha256")
            .update(
              JSON.stringify([
                "recovery",
                observation.executionId,
                observation.invocationId,
                observation.usage.input,
                observation.usage.output,
                observation.usage.cacheRead,
                observation.usage.cacheWrite,
              ]),
            )
            .digest("hex"),
          runId: `recovery:${observation.invocationId}`,
          usage: {
            measurement: observation.usage.measurement,
            ...recovered,
            totalTokens,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        context,
      );
    },
    getOverview(period) {
      const startDate = periodStartDate(period, currentTime(), storedTimezone);
      const where = startDate === undefined ? "" : "WHERE local_date >= ?";
      const totals = readTotals(
        database
          .prepare(
            `SELECT
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
              COALESCE(SUM(total_tokens), 0) AS totalTokens
             FROM usage_observations ${where}`,
          )
          .get(...(startDate === undefined ? [] : [startDate])),
      );
      const rows = database
        .prepare(
          `SELECT local_date AS date,
            SUM(input_tokens) AS input,
            SUM(output_tokens) AS output,
            SUM(cache_read_tokens) AS cacheRead,
            SUM(cache_write_tokens) AS cacheWrite,
            SUM(total_tokens) AS totalTokens
           FROM usage_observations ${where}
           GROUP BY local_date ORDER BY local_date`,
        )
        .all(...(startDate === undefined ? [] : [startDate])) as unknown as Array<
        UsageTokenTotals & { date: string }
      >;
      return {
        revision: currentRevision,
        trackingStartedAt,
        timezone: storedTimezone,
        totals,
        daily: fillDailySeries(period, trackingStartedAt, storedTimezone, rows, currentTime()),
      };
    },
    listSubjects({ period, kind, offset, limit }) {
      const startDate = periodStartDate(period, currentTime(), storedTimezone);
      const cutoffClause = startDate === undefined ? "" : "AND o.local_date >= ?";
      const parameters = startDate === undefined ? [kind] : [kind, startDate];
      const totalRow = database
        .prepare(
          `SELECT COUNT(*) AS total FROM (
            SELECT a.subject_id
            FROM usage_attributions a
            JOIN usage_observations o ON o.observation_id = a.observation_id
            WHERE a.kind = ? ${cutoffClause}
            GROUP BY a.subject_id
          )`,
        )
        .get(...parameters) as { total: number };
      const globalTotal = readTotals(
        database
          .prepare(
            `SELECT COALESCE(SUM(total_tokens), 0) AS totalTokens
             FROM usage_observations ${startDate === undefined ? "" : "WHERE local_date >= ?"}`,
          )
          .get(...(startDate === undefined ? [] : [startDate])),
      ).totalTokens;
      const rows = database
        .prepare(
          `SELECT a.subject_id AS id, s.name, s.deleted,
            SUM(o.input_tokens) AS input,
            SUM(o.output_tokens) AS output,
            SUM(o.cache_read_tokens) AS cacheRead,
            SUM(o.cache_write_tokens) AS cacheWrite,
            SUM(o.total_tokens) AS totalTokens
           FROM usage_attributions a
           JOIN usage_observations o ON o.observation_id = a.observation_id
           JOIN usage_subjects s ON s.kind = a.kind AND s.subject_id = a.subject_id
           WHERE a.kind = ? ${cutoffClause}
           GROUP BY a.subject_id, s.name, s.deleted
           ORDER BY totalTokens DESC, s.name COLLATE NOCASE, a.subject_id
           LIMIT ? OFFSET ?`,
        )
        .all(...parameters, limit, offset) as unknown as Array<
        UsageTokenTotals & { id: string; name: string; deleted: number }
      >;
      return {
        revision: currentRevision,
        total: Number(totalRow.total),
        items: rows.map((row) => ({
          kind,
          id: row.id,
          name: row.name,
          deleted: Boolean(row.deleted),
          usage: readTotals(row),
          share: globalTotal === 0 ? 0 : Math.min(row.totalTokens / globalTotal, 1),
        })),
      };
    },
    getMissionUsage(missionId) {
      return {
        revision: currentRevision,
        trackingStartedAt,
        usage: persistedMissionTotals(missionId),
        provisional: [...previews.values()].some(
          (preview) => preview.context.mission.id === missionId,
        ),
      };
    },
    markMissionDeleted(missionId) {
      const result = database
        .prepare(
          `UPDATE usage_subjects SET name = 'Deleted Mission', deleted = 1
           WHERE kind = 'mission' AND subject_id = ?`,
        )
        .run(missionId);
      if (Number(result.changes) > 0) publish(missionId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      previews.clear();
      database.close();
    },
  };
  return store;
}

function resolveSubjects(
  observation: RuntimeUsageObservation,
  context: UsageObservationContext,
): Array<{
  readonly kind: UsageSubjectKind;
  readonly id: string;
  readonly name: string;
  readonly relation: "direct" | "inclusive";
}> {
  const invocations = new Map(
    context.invocations.map((invocation) => [invocation.invocationId, invocation]),
  );
  const current = invocations.get(observation.invocationId);
  const subjects = new Map<
    string,
    {
      readonly kind: UsageSubjectKind;
      readonly id: string;
      readonly name: string;
      readonly relation: "direct" | "inclusive";
    }
  >();
  const add = (
    kind: UsageSubjectKind,
    id: string,
    relation: "direct" | "inclusive",
    fallback = id,
  ): void => {
    subjects.set(`${kind}:${id}`, {
      kind,
      id,
      name: context.names.get(id) ?? fallback,
      relation,
    });
  };
  add("mission", context.mission.id, "direct", context.mission.title);
  add("expert", observation.executor.id, "direct", observation.executor.name);
  let cursor = current;
  const visited = new Set<string>();
  while (cursor !== undefined && !visited.has(cursor.invocationId)) {
    visited.add(cursor.invocationId);
    if (cursor.definition.kind === "expert-team") {
      add("team", cursor.definition.id, "inclusive");
    } else if (cursor.definition.kind === "flow") {
      add("flow", cursor.definition.id, "inclusive");
    }
    cursor =
      cursor.parentInvocationId === undefined
        ? undefined
        : invocations.get(cursor.parentInvocationId);
  }
  return [...subjects.values()];
}

function observationSignature(observation: RuntimeUsageObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        executionId: observation.executionId,
        invocationId: observation.invocationId,
        contextId: observation.contextId,
        runId: observation.runId,
        runtimeId: observation.runtimeId,
        modelSelection: observation.modelSelection,
        usage: {
          measurement: observation.usage.measurement,
          input: observation.usage.input,
          output: observation.usage.output,
          cacheRead: observation.usage.cacheRead,
          cacheWrite: observation.usage.cacheWrite,
          totalTokens: observation.usage.totalTokens,
        },
      }),
    )
    .digest("hex");
}

function readTotals(value: unknown): UsageTokenTotals {
  const row = (value ?? {}) as Partial<Record<keyof UsageTokenTotals, unknown>>;
  return {
    input: Number(row.input ?? 0),
    output: Number(row.output ?? 0),
    cacheRead: Number(row.cacheRead ?? 0),
    cacheWrite: Number(row.cacheWrite ?? 0),
    totalTokens: Number(row.totalTokens ?? 0),
  };
}

function addTotals(
  current: UsageTokenTotals,
  next: Pick<UsageTokenTotals, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">,
): UsageTokenTotals {
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    totalTokens: current.totalTokens + next.totalTokens,
  };
}

function periodStartDate(period: UsagePeriod, now: Date, timezone: string): string | undefined {
  if (period === "all") return undefined;
  const days = period === "7d" ? 7 : 30;
  return addCalendarDays(localDate(now.toISOString(), timezone), -(days - 1));
}

function localDate(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function fillDailySeries(
  period: UsagePeriod,
  trackingStartedAt: string,
  timezone: string,
  rows: Array<UsageTokenTotals & { date: string }>,
  now: Date,
): Array<UsageTokenTotals & { date: string }> {
  if (period === "all") return rows.map((row) => ({ date: row.date, ...readTotals(row) }));
  const count = period === "7d" ? 7 : 30;
  const byDate = new Map(rows.map((row) => [row.date, readTotals(row)]));
  const result: Array<UsageTokenTotals & { date: string }> = [];
  const firstTrackedDate = localDate(trackingStartedAt, timezone);
  const startDate = periodStartDate(period, now, timezone)!;
  for (let index = 0; index < count; index++) {
    const date = addCalendarDays(startDate, index);
    if (date >= firstTrackedDate) {
      result.push({ date, ...(byDate.get(date) ?? EMPTY_USAGE) });
    }
  }
  return result;
}

function addCalendarDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
