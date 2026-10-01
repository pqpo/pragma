import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  RuntimeUsageObservedSchema,
  type CanonicalEventFeed,
  type PragmaLogger,
  type RuntimeUsageObservation,
} from "@pragma/core";
import { ExecutionEventSchema } from "@pragma/shared";
import { MissionSchema, type Mission } from "../../../shared/contracts/index.ts";

const LinkSchema = z.object({ mission: MissionSchema, requestId: z.string().min(1) });
const TaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("usage"), observation: RuntimeUsageObservedSchema.shape.observation }),
  z.object({ kind: z.literal("terminal"), status: z.enum(["succeeded", "failed", "cancelled"]) }),
]);
type Task = z.infer<typeof TaskSchema>;
export type MissionDeliveryStep = "terminal" | "metadata" | "memory" | "history" | "archive";
const STEPS: readonly MissionDeliveryStep[] = [
  "terminal",
  "metadata",
  "memory",
  "history",
  "archive",
];

/** Execution facts enter this queue only through the atomic canonical handoff. */
export async function createMissionDelivery(input: {
  path: string;
  feed: CanonicalEventFeed;
  logger: PragmaLogger;
  usage: (mission: Mission, observation: RuntimeUsageObservation) => Promise<void>;
  onDegraded?: (missionId: string) => void;
  onRecovered?: (missionId: string) => void;
  beforeDelete?: (mission: Mission, executionIds: readonly string[]) => Promise<void>;
  terminal: (
    mission: Mission,
    executionId: string,
    requestId: string,
    status: "succeeded" | "failed" | "cancelled",
    step: MissionDeliveryStep,
  ) => Promise<void>;
}) {
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(input.path);
  try {
    const existing = db
      .prepare("SELECT name FROM sqlite_master WHERE name='delivery_metadata'")
      .get();
    if (existing !== undefined) {
      const version = db
        .prepare("SELECT value FROM delivery_metadata WHERE key='version'")
        .get() as { value: string } | undefined;
      if (version?.value !== "pragma.mission-delivery/v1") {
        throw new Error("Unsupported Mission delivery version.");
      }
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;");
    db.exec(`CREATE TABLE IF NOT EXISTS delivery_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_links (execution_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS links_mission ON execution_links(mission_id);
    CREATE TABLE IF NOT EXISTS deleted_missions (mission_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS deleted_executions (execution_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS delivery_tasks (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, mission_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      payload TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', error_code TEXT,
      claim TEXT, expires_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS delivery_pending ON delivery_tasks(state,next_at,sequence);
    CREATE INDEX IF NOT EXISTS delivery_linked_pending ON delivery_tasks(state,next_at,sequence)
      WHERE mission_id NOT GLOB 'unlinked:*';
    CREATE INDEX IF NOT EXISTS delivery_owner ON delivery_tasks(mission_id,sequence);
    INSERT OR IGNORE INTO delivery_metadata VALUES ('version','pragma.mission-delivery/v1');
    INSERT OR IGNORE INTO delivery_metadata VALUES ('cursor','0');`);
    const version = db.prepare("SELECT value FROM delivery_metadata WHERE key='version'").get() as {
      value: string;
    };
    if (version.value !== "pragma.mission-delivery/v1") {
      throw new Error("Unsupported Mission delivery version.");
    }
  } catch (error) {
    db.close();
    throw error;
  }
  let stopped = true;
  let closed = false;
  let closing: Promise<void> | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = new Map<string, Promise<void>>();
  const activeOwners = new Map<string, string>();
  let lastError: string | undefined;
  const cursor = () =>
    Number(
      (
        db.prepare("SELECT value FROM delivery_metadata WHERE key='cursor'").get() as {
          value: string;
        }
      ).value,
    );
  const transaction = <T>(action: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const isDeleted = (missionId: string) =>
    db.prepare("SELECT 1 FROM deleted_missions WHERE mission_id=?").get(missionId) !== undefined;
  const ingest = async () => {
    const after = cursor();
    const page = await input.feed.read({ after: { sequence: after }, limit: 64 });
    transaction(() => {
      // Read the watermark inside the receipt transaction to reject stale pages.
      const received = cursor();
      for (const item of page.items) {
        if (item.cursor.sequence <= received) continue;
        if (item.kind !== "event") {
          // Take durable custody of the unreadable envelope before advancing.
          // One damaged source must not indefinitely block unrelated owners.
          const id = `unreadable:${item.cursor.sequence}`;
          db.prepare(
            "INSERT OR IGNORE INTO delivery_tasks(id,execution_id,mission_id,sequence,payload,state,error_code) VALUES (?,?,?,?,?,'needs_attention','MISSION_DELIVERY_INVALID_ENVELOPE')",
          ).run(id, id, `unlinked:${id}`, item.cursor.sequence, JSON.stringify(item));
          input.logger.warn(
            "mission.delivery_degraded",
            "Unreadable source retained for inspection",
            {
              moduleId: "pragma.mission-delivery",
              errorCode: "MISSION_DELIVERY_INVALID_ENVELOPE",
            },
          );
          continue;
        }
        if (item.event.topic !== "pragma.execution.event.committed") continue;
        const parsedEvent = ExecutionEventSchema.safeParse(item.event.payload);
        if (!parsedEvent.success) {
          const executionId =
            item.event.sourceRef.ownerRef?.id ??
            item.event.correlationId ??
            `unreadable:${item.event.eventId}`;
          if (
            db.prepare("SELECT 1 FROM deleted_executions WHERE execution_id=?").get(executionId) !==
            undefined
          )
            continue;
          const link = db
            .prepare("SELECT mission_id FROM execution_links WHERE execution_id=?")
            .get(executionId) as { mission_id: string } | undefined;
          if (link !== undefined && isDeleted(link.mission_id)) continue;
          const missionId = link?.mission_id ?? `unlinked:${executionId}`;
          db.prepare(
            "INSERT OR IGNORE INTO delivery_tasks(id,execution_id,mission_id,sequence,payload,state,error_code) VALUES (?,?,?,?,?,'needs_attention','MISSION_DELIVERY_INVALID_TASK')",
          ).run(
            `invalid:${item.event.eventId}`,
            executionId,
            missionId,
            item.cursor.sequence,
            JSON.stringify({ kind: "invalid", source: item.event.payload }),
          );
          input.logger.warn(
            "mission.delivery_degraded",
            "Invalid execution fact retained for inspection",
            {
              missionId,
              moduleId: "pragma.mission-delivery",
              errorCode: "MISSION_DELIVERY_INVALID_TASK",
            },
          );
          if (link !== undefined) input.onDegraded?.(missionId);
          continue;
        }
        const event = parsedEvent.data;
        if (
          event.type !== "runtime.usage.observed" &&
          ![
            "execution.succeeded",
            "execution.failed",
            "execution.cancelled",
            "execution.interrupted",
          ].includes(event.type)
        )
          continue;
        if (
          db
            .prepare("SELECT 1 FROM deleted_executions WHERE execution_id=?")
            .get(event.executionId) !== undefined
        )
          continue;
        const link = db
          .prepare("SELECT mission_id FROM execution_links WHERE execution_id=?")
          .get(event.executionId) as { mission_id: string } | undefined;
        if (link !== undefined && isDeleted(link.mission_id)) continue;
        const usage =
          event.type === "runtime.usage.observed"
            ? RuntimeUsageObservedSchema.safeParse(event.data)
            : undefined;
        if (
          usage !== undefined &&
          (!usage.success ||
            usage.data.observation.executionId !== event.executionId ||
            usage.data.observation.invocationId !== event.invocationId)
        ) {
          const missionId = link?.mission_id ?? `unlinked:${event.executionId}`;
          db.prepare(
            "INSERT OR IGNORE INTO delivery_tasks(id,execution_id,mission_id,sequence,payload,state,error_code) VALUES (?,?,?,?,?,'needs_attention','MISSION_DELIVERY_INVALID_TASK')",
          ).run(
            `invalid:${event.eventId}`,
            event.executionId,
            missionId,
            item.cursor.sequence,
            JSON.stringify({ kind: "invalid", source: event.data }),
          );
          if (link !== undefined) input.onDegraded?.(missionId);
          input.logger.warn(
            "mission.delivery_degraded",
            "Invalid usage fact retained for inspection",
            {
              missionId,
              moduleId: "pragma.mission-delivery",
              errorCode: "MISSION_DELIVERY_INVALID_TASK",
            },
          );
          continue;
        }
        const task: Task =
          event.type === "runtime.usage.observed"
            ? {
                kind: "usage",
                observation: usage!.data!.observation,
              }
            : {
                kind: "terminal",
                status:
                  event.type === "execution.succeeded"
                    ? "succeeded"
                    : event.type === "execution.failed"
                      ? "failed"
                      : "cancelled",
              };
        const id =
          task.kind === "usage"
            ? `usage:${task.observation.observationId}`
            : `terminal:${event.executionId}`;
        for (const step of task.kind === "usage" ? [0] : STEPS.map((_, index) => index)) {
          db.prepare(
            "INSERT OR IGNORE INTO delivery_tasks(id,execution_id,mission_id,sequence,payload,step) VALUES (?,?,?,?,?,?)",
          ).run(
            `${id}:${step}`,
            event.executionId,
            link?.mission_id ?? `unlinked:${event.executionId}`,
            item.cursor.sequence,
            JSON.stringify(task),
            step,
          );
        }
      }
      db.prepare("UPDATE delivery_metadata SET value=? WHERE key='cursor'").run(
        String(Math.max(cursor(), page.nextCursor.sequence)),
      );
    });
  };
  type Row = {
    id: string;
    execution_id: string;
    mission_id: string;
    payload: string;
    step: number;
    attempts: number;
  };
  const deliver = async (row: Row, claim: string) => {
    const heartbeat = setInterval(() => {
      db.prepare("UPDATE delivery_tasks SET expires_at=? WHERE id=? AND claim=?").run(
        Date.now() + 60_000,
        row.id,
        claim,
      );
    }, 10_000);
    heartbeat.unref();
    try {
      const link = db
        .prepare("SELECT payload FROM execution_links WHERE execution_id=?")
        .get(row.execution_id) as { payload: string } | undefined;
      if (link === undefined || isDeleted(row.mission_id)) return;
      const { mission, requestId } = LinkSchema.parse(JSON.parse(link.payload));
      const task = TaskSchema.parse(JSON.parse(row.payload));
      if (task.kind === "usage") await input.usage(mission, task.observation);
      else {
        if (isDeleted(row.mission_id)) return;
        const owned = db
          .prepare("SELECT 1 FROM delivery_tasks WHERE id=? AND claim=?")
          .get(row.id, claim);
        if (owned === undefined) return;
        await input.terminal(mission, row.execution_id, requestId, task.status, STEPS[row.step]!);
      }
      db.prepare("DELETE FROM delivery_tasks WHERE id=? AND claim=?").run(row.id, claim);
      if (
        row.attempts > 0 &&
        db
          .prepare(
            "SELECT 1 FROM delivery_tasks WHERE mission_id=? AND error_code IS NOT NULL LIMIT 1",
          )
          .get(row.mission_id) === undefined
      )
        input.onRecovered?.(row.mission_id);
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      const code = invalid ? "MISSION_DELIVERY_INVALID_TASK" : "MISSION_DELIVERY_RETRY_PENDING";
      input.onDegraded?.(row.mission_id);
      db.prepare(
        "UPDATE delivery_tasks SET state=?,error_code=?,attempts=attempts+1,next_at=?,claim=NULL,expires_at=0 WHERE id=? AND claim=?",
      ).run(
        invalid ? "needs_attention" : "pending",
        code,
        Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6)),
        row.id,
        claim,
      );
      input.logger.warn("mission.delivery_degraded", "Mission background delivery needs recovery", {
        missionId: row.mission_id,
        executionId: row.execution_id,
        moduleId: "pragma.mission-delivery",
        errorCode: code,
        error,
      });
    } finally {
      clearInterval(heartbeat);
    }
  };
  const dispatchPending = () => {
    while (active.size < 2 && !stopped) {
      const claimed = transaction(() => {
        const row = db
          .prepare(
            `SELECT t.* FROM delivery_tasks t INDEXED BY delivery_linked_pending
          WHERE t.mission_id NOT GLOB 'unlinked:*' AND t.state='pending' AND t.next_at<=? AND t.expires_at<=?
          AND NOT EXISTS(SELECT 1 FROM delivery_tasks older WHERE older.mission_id=t.mission_id AND older.sequence<t.sequence AND older.step=t.step AND json_extract(older.payload,'$.kind')=json_extract(t.payload,'$.kind'))
          AND NOT EXISTS(SELECT 1 FROM delivery_tasks busy WHERE busy.mission_id=t.mission_id AND busy.expires_at>?)
          AND NOT (json_extract(t.payload,'$.kind')='terminal' AND t.step=4 AND EXISTS(SELECT 1 FROM delivery_tasks h WHERE h.execution_id=t.execution_id AND h.step=3 AND json_extract(h.payload,'$.kind')='terminal'))
          AND NOT EXISTS(SELECT 1 FROM deleted_missions d WHERE d.mission_id=t.mission_id)
          AND EXISTS(SELECT 1 FROM execution_links l WHERE l.execution_id=t.execution_id)
          ORDER BY t.sequence LIMIT 1`,
          )
          .get(Date.now(), Date.now(), Date.now()) as Row | undefined;
        if (row === undefined) return undefined;
        const claim = randomUUID();
        db.prepare("UPDATE delivery_tasks SET claim=?,expires_at=? WHERE id=?").run(
          claim,
          Date.now() + 60_000,
          row.id,
        );
        return { row, claim };
      });
      if (claimed === undefined) break;
      const operation = deliver(claimed.row, claimed.claim);
      active.set(claimed.row.id, operation);
      activeOwners.set(claimed.row.id, claimed.row.mission_id);
      void operation
        .catch((error: unknown) => {
          input.logger.warn("mission.delivery_degraded", "Mission delivery claim needs recovery", {
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_CLAIM_FAILED",
            error,
          });
        })
        .finally(() => {
          active.delete(claimed.row.id);
          activeOwners.delete(claimed.row.id);
        });
    }
  };
  const tick = async () => {
    // Receipt custody is independent of source availability. Start recovered
    // tasks before intake and also dispatch facts received in this tick.
    dispatchPending();
    try {
      await ingest();
      lastError = undefined;
    } catch (error) {
      lastError = "MISSION_DELIVERY_RECEIVE_FAILED";
      input.logger.warn("mission.delivery_degraded", "Mission delivery intake needs recovery", {
        moduleId: "pragma.mission-delivery",
        errorCode: lastError,
        error,
      });
    }
    dispatchPending();
  };
  const wake = () => {
    if (stopped || running !== undefined) return;
    if (timer !== undefined) clearTimeout(timer);
    running = tick()
      .catch((error: unknown) => {
        lastError = "MISSION_DELIVERY_CLAIM_FAILED";
        input.logger.warn("mission.delivery_degraded", "Mission delivery claim needs recovery", {
          moduleId: "pragma.mission-delivery",
          errorCode: lastError,
          error,
        });
      })
      .finally(() => {
        running = undefined;
        if (!stopped) {
          timer = setTimeout(wake, 500);
          timer.unref();
        }
      });
  };
  return {
    register(mission: Mission, executionId: string, requestId: string) {
      if (closing !== undefined) throw new Error("MISSION_DELIVERY_CLOSING");
      if (isDeleted(mission.id)) throw new Error("MISSION_DELIVERY_OWNER_DELETED");
      const existing = db
        .prepare("SELECT mission_id,payload FROM execution_links WHERE execution_id=?")
        .get(executionId) as { mission_id: string; payload: string } | undefined;
      if (
        existing !== undefined &&
        (existing.mission_id !== mission.id ||
          LinkSchema.parse(JSON.parse(existing.payload)).requestId !== requestId)
      )
        throw new Error("MISSION_DELIVERY_OWNER_CONFLICT");
      if (
        db.prepare("SELECT 1 FROM deleted_executions WHERE execution_id=?").get(executionId) !==
        undefined
      )
        throw new Error("MISSION_DELIVERY_OWNER_DELETED");
      // Accessing a Mission is not a delivery retry or a metadata write.
      // The consumer reloads current metadata when executing each task.
      if (existing !== undefined) return;
      transaction(() => {
        db.prepare("INSERT INTO execution_links VALUES (?,?,?)").run(
          executionId,
          mission.id,
          JSON.stringify(LinkSchema.parse({ mission, requestId })),
        );
        db.prepare("UPDATE delivery_tasks SET mission_id=? WHERE execution_id=?").run(
          mission.id,
          executionId,
        );
      });
      if (
        db
          .prepare(
            "SELECT 1 FROM delivery_tasks WHERE mission_id=? AND error_code IS NOT NULL LIMIT 1",
          )
          .get(mission.id) !== undefined
      )
        input.onDegraded?.(mission.id);
      wake();
    },
    retry(missionId: string) {
      db.prepare(
        "UPDATE delivery_tasks SET state='pending',next_at=0,error_code=NULL WHERE mission_id=? AND claim IS NULL",
      ).run(missionId);
      wake();
    },
    safeThrough: cursor,
    wake,
    start() {
      stopped = false;
      wake();
    },
    inspect() {
      const failed = db
        .prepare("SELECT error_code FROM delivery_tasks WHERE error_code IS NOT NULL LIMIT 1")
        .get() as { error_code: string } | undefined;
      return {
        state:
          lastError === undefined && failed === undefined
            ? ("healthy" as const)
            : ("degraded" as const),
        errorCode: lastError ?? failed?.error_code,
        pending: Number(
          (db.prepare("SELECT COUNT(*) AS count FROM delivery_tasks").get() as { count: number })
            .count,
        ),
      };
    },
    async deleteMission(
      missionId: string,
      owner?: { readonly mission: Mission; readonly executionIds: readonly string[] },
    ) {
      const links = db
        .prepare("SELECT execution_id,payload FROM execution_links WHERE mission_id=?")
        .all(missionId) as { execution_id: string; payload: string }[];
      const executionIds = [
        ...new Set([...links.map((link) => link.execution_id), ...(owner?.executionIds ?? [])]),
      ];
      const mission =
        owner?.mission ??
        (links.length === 0 ? undefined : LinkSchema.parse(JSON.parse(links[0]!.payload)).mission);
      if (mission !== undefined) await input.beforeDelete?.(mission, executionIds);
      transaction(() => {
        db.prepare("INSERT OR IGNORE INTO deleted_missions VALUES (?)").run(missionId);
        for (const executionId of executionIds) {
          db.prepare("INSERT OR IGNORE INTO deleted_executions VALUES (?)").run(executionId);
          // Also cover facts staged before their association was persisted.
          db.prepare("DELETE FROM delivery_tasks WHERE execution_id=?").run(executionId);
        }
      });
      await running;
      await Promise.all(
        [...active]
          .filter(([id]) => activeOwners.get(id) === missionId)
          .map(([, operation]) => operation),
      );
      transaction(() => {
        db.prepare("DELETE FROM delivery_tasks WHERE mission_id=?").run(missionId);
        db.prepare("DELETE FROM execution_links WHERE mission_id=?").run(missionId);
      });
    },
    async close() {
      if (closing !== undefined) return await closing;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      const settling = (async () => {
        await running;
        await Promise.all(active.values());
        if (!closed) {
          closed = true;
          db.close();
        }
      })();
      closing = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          input.logger.warn(
            "mission.delivery_shutdown_pending",
            "Mission delivery remains durable for restart",
            {
              moduleId: "pragma.mission-delivery",
              errorCode: "MISSION_DELIVERY_SHUTDOWN_PENDING",
              pending: active.size,
            },
          );
          resolve();
        }, 5000);
        settling.then(
          () => {
            clearTimeout(deadline);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(deadline);
            reject(error);
          },
        );
      });
      await closing;
    },
  };
}
