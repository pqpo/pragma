import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RuntimeUsageObservedSchema, type CanonicalEventPage } from "@pragma/core";
import { ExecutionEventSchema } from "@pragma/shared";
// Desktop owns the Mission protocol. The custody store checks only outer identity.
const LinkSchema = z.object({
  mission: z.object({ id: z.string().min(1) }).passthrough(),
  requestId: z.string().min(1),
});
const STEPS = ["terminal", "metadata", "memory", "history", "archive"] as const;
type Task =
  | { kind: "usage"; observation: z.infer<typeof RuntimeUsageObservedSchema>["observation"] }
  | { kind: "terminal"; status: "succeeded" | "failed" | "cancelled" };
export interface MissionReceiptNotice {
  event: string;
  message: string;
  data: Record<string, unknown>;
}
export async function executeMissionReceipt(path: string, operation: string, args: unknown[] = []) {
  const input = { path };
  const notices: MissionReceiptNotice[] = [];
  const report = (event: string, message: string, data: Record<string, unknown>) =>
    notices.push({ event, message, data });
  const degraded = (missionId: string) =>
    report("mission.delivery_degraded", "Mission delivery requires attention", {
      missionId,
      moduleId: "pragma.mission-delivery",
      errorCode: "MISSION_DELIVERY_INVALID_TASK",
    });
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
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;");
    if (existing === undefined)
      db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS delivery_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
  function stagePage(page: CanonicalEventPage) {
    if (page.nextCursor.sequence <= cursor()) return;
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
          report("mission.delivery_degraded", "Unreadable source retained for inspection", {
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_INVALID_ENVELOPE",
          });
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
          report("mission.delivery_degraded", "Invalid execution fact retained for inspection", {
            missionId,
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_INVALID_TASK",
          });
          if (link !== undefined) degraded(missionId);
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
          if (link !== undefined) degraded(missionId);
          report("mission.delivery_degraded", "Invalid usage fact retained for inspection", {
            missionId,
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_INVALID_TASK",
          });
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
  }
  type Row = {
    id: string;
    execution_id: string;
    mission_id: string;
    payload: string;
    step: number;
    attempts: number;
  };
  const eligibility = `
    t.mission_id NOT GLOB 'unlinked:*' AND t.state='pending'
    AND NOT EXISTS(SELECT 1 FROM delivery_tasks older WHERE older.mission_id=t.mission_id AND older.sequence<t.sequence AND older.step=t.step AND json_extract(older.payload,'$.kind')=json_extract(t.payload,'$.kind'))
    AND NOT (json_extract(t.payload,'$.kind')='terminal' AND t.step=4 AND EXISTS(SELECT 1 FROM delivery_tasks h WHERE h.execution_id=t.execution_id AND h.step=3 AND json_extract(h.payload,'$.kind')='terminal'))
    AND NOT EXISTS(SELECT 1 FROM deleted_missions d WHERE d.mission_id=t.mission_id)
    AND EXISTS(SELECT 1 FROM execution_links l WHERE l.execution_id=t.execution_id)`;
  function claim() {
    const select = db.prepare(`SELECT t.* FROM delivery_tasks t INDEXED BY delivery_linked_pending
      WHERE ${eligibility} AND t.next_at<=? AND t.expires_at<=?
      AND NOT EXISTS(SELECT 1 FROM delivery_tasks busy WHERE busy.mission_id=t.mission_id AND busy.expires_at>?)
      ORDER BY t.sequence LIMIT 1`);
    const candidate = () => select.get(Date.now(), Date.now(), Date.now()) as Row | undefined;
    // Idle consumers do not acquire a write lock. Recheck under the transaction for competing owners.
    if (candidate() === undefined) return undefined;
    return transaction(() => {
      const row = candidate();
      if (row === undefined) return undefined;
      const claim = randomUUID();
      db.prepare("UPDATE delivery_tasks SET claim=?,expires_at=? WHERE id=?").run(
        claim,
        Date.now() + 60_000,
        row.id,
      );
      return { row, claim };
    });
  }
  function register(mission: { id: string }, executionId: string, requestId: string) {
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
      if (
        isDeleted(mission.id) ||
        db.prepare("SELECT 1 FROM deleted_executions WHERE execution_id=?").get(executionId) !==
          undefined
      )
        throw new Error("MISSION_DELIVERY_OWNER_DELETED");
      const raced = db
        .prepare("SELECT mission_id,payload FROM execution_links WHERE execution_id=?")
        .get(executionId) as { mission_id: string; payload: string } | undefined;
      if (raced !== undefined) {
        if (
          raced.mission_id !== mission.id ||
          LinkSchema.parse(JSON.parse(raced.payload)).requestId !== requestId
        )
          throw new Error("MISSION_DELIVERY_OWNER_CONFLICT");
        return;
      }
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
      degraded(mission.id);
  }
  let value: unknown;
  try {
    switch (operation) {
      case "open":
        value = cursor();
        break;
      case "stagePage":
        stagePage(args[0] as CanonicalEventPage);
        value = cursor();
        break;
      case "register": {
        const [executionId, missionId, payload] = args as [string, string, string];
        if (Buffer.byteLength(payload) > 1024 * 1024)
          throw new Error("MISSION_DELIVERY_PAYLOAD_TOO_LARGE");
        const link = LinkSchema.parse(JSON.parse(payload));
        if (link.mission.id !== missionId) throw new Error("MISSION_DELIVERY_OWNER_CONFLICT");
        register(link.mission, executionId, link.requestId);
        break;
      }
      case "claim":
        value = claim();
        break;
      case "link":
        value = db
          .prepare("SELECT payload FROM execution_links WHERE execution_id=?")
          .get(args[0] as string);
        break;
      case "owned":
        value =
          db
            .prepare("SELECT 1 FROM delivery_tasks WHERE id=? AND claim=?")
            .get(args[0] as string, args[1] as string) !== undefined;
        break;
      case "isDeleted":
        value = isDeleted(args[0] as string);
        break;
      case "renew":
        db.prepare("UPDATE delivery_tasks SET expires_at=? WHERE id=? AND claim=?").run(
          Date.now() + 60_000,
          args[0] as string,
          args[1] as string,
        );
        break;
      case "acknowledge": {
        const [id, claim, missionId] = args as string[];
        db.prepare("DELETE FROM delivery_tasks WHERE id=? AND claim=?").run(id!, claim!);
        value =
          db
            .prepare(
              "SELECT 1 FROM delivery_tasks WHERE mission_id=? AND error_code IS NOT NULL LIMIT 1",
            )
            .get(missionId!) === undefined;
        break;
      }
      case "fail": {
        const [id, claim, invalid, attempts] = args as [string, string, boolean, number];
        db.prepare(
          "UPDATE delivery_tasks SET state=?,error_code=?,attempts=attempts+1,next_at=?,claim=NULL,expires_at=0 WHERE id=? AND claim=?",
        ).run(
          invalid ? "needs_attention" : "pending",
          invalid ? "MISSION_DELIVERY_INVALID_TASK" : "MISSION_DELIVERY_RETRY_PENDING",
          Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)),
          id,
          claim,
        );
        break;
      }
      case "retry":
        db.prepare(
          "UPDATE delivery_tasks SET state='pending',next_at=0,error_code=NULL WHERE mission_id=? AND claim IS NULL",
        ).run(args[0] as string);
        break;
      case "links":
        value = db
          .prepare("SELECT execution_id,payload FROM execution_links WHERE mission_id=?")
          .all(args[0] as string);
        break;
      case "markDeleted":
        transaction(() => {
          const [missionId, executionIds] = args as [string, string[]];
          db.prepare("INSERT OR IGNORE INTO deleted_missions VALUES (?)").run(missionId);
          for (const id of executionIds) {
            db.prepare("INSERT OR IGNORE INTO deleted_executions VALUES (?)").run(id);
            db.prepare("DELETE FROM delivery_tasks WHERE execution_id=?").run(id);
          }
        });
        break;
      case "finishDelete":
        transaction(() => {
          db.prepare("DELETE FROM delivery_tasks WHERE mission_id=?").run(args[0] as string);
          db.prepare("DELETE FROM execution_links WHERE mission_id=?").run(args[0] as string);
        });
        break;
      case "inspect": {
        const failure = db
          .prepare("SELECT error_code FROM delivery_tasks WHERE error_code IS NOT NULL LIMIT 1")
          .get() as { error_code: string } | undefined;
        value = {
          state: failure === undefined ? "healthy" : "degraded",
          errorCode: failure?.error_code,
          pending: (
            db.prepare("SELECT COUNT(*) AS count FROM delivery_tasks").get() as { count: number }
          ).count,
          nextWakeAt:
            (
              db
                .prepare(
                  `SELECT MIN(MAX(t.next_at,t.expires_at)) AS due FROM delivery_tasks t
                    WHERE ${eligibility}
                    AND NOT EXISTS(SELECT 1 FROM delivery_tasks busy WHERE busy.mission_id=t.mission_id AND busy.id<>t.id AND busy.expires_at>?)`,
                )
                .get(Date.now()) as { due: number | null }
            ).due ?? undefined,
        };
        break;
      }
      default:
        throw new Error("Unsupported Mission receipt operation.");
    }
    return { value, notices };
  } finally {
    db.close();
  }
}
