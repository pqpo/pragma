import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { RuntimeUsageObservedSchema, type CanonicalEventPage } from "@pragma/core";
import { ExecutionEventSchema } from "@pragma/shared";
export async function executeUsageReceipt(path: string, operation: string, input?: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  const errors: string[] = [];
  const report = (error: unknown) =>
    errors.push((error as { code?: string }).code ?? "USAGE_DELIVERY_INVALID_FACT");
  try {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='usage_delivery_metadata'")
      .get();
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;");
    if (exists === undefined)
      db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE usage_delivery_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO usage_delivery_metadata VALUES('version','pragma.local-host-usage-delivery/v1');
      INSERT INTO usage_delivery_metadata VALUES('cursor','0');
      CREATE TABLE usage_delivery_pending(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE usage_delivery_quarantine(id TEXT PRIMARY KEY,payload TEXT NOT NULL,error_code TEXT NOT NULL);`);
    if (
      (
        db.prepare("SELECT value FROM usage_delivery_metadata WHERE key='version'").get() as {
          value: string;
        }
      ).value !== "pragma.local-host-usage-delivery/v1"
    )
      throw new Error("Unsupported usage delivery version.");
    const cursor = () =>
      Number(
        (
          db.prepare("SELECT value FROM usage_delivery_metadata WHERE key='cursor'").get() as {
            value: string;
          }
        ).value,
      );
    let value: unknown;
    let pendingDelta = 0;
    switch (operation) {
      case "page": {
        const page = input as CanonicalEventPage;
        if (page.nextCursor.sequence <= cursor()) break;
        db.exec("BEGIN IMMEDIATE");
        try {
          const received = cursor();
          for (const item of page.items) {
            if (item.cursor.sequence <= received) continue;
            if (item.kind !== "event") {
              db.prepare("INSERT OR IGNORE INTO usage_delivery_quarantine VALUES(?,?,?)").run(
                `unreadable:${item.cursor.sequence}`,
                JSON.stringify(item),
                "USAGE_DELIVERY_INVALID_ENVELOPE",
              );
              report(
                Object.assign(new Error("Unreadable usage source retained"), {
                  code: "USAGE_DELIVERY_INVALID_ENVELOPE",
                }),
              );
              continue;
            }
            if (item.event.topic !== "pragma.execution.event.committed") continue;
            const parsed = ExecutionEventSchema.safeParse(item.event.payload);
            if (parsed.success && parsed.data.type !== "runtime.usage.observed") continue;
            const usage = parsed.success
              ? RuntimeUsageObservedSchema.safeParse(parsed.data.data)
              : undefined;
            if (
              usage === undefined ||
              !usage.success ||
              !parsed.success ||
              usage.data.observation.executionId !== parsed.data.executionId ||
              usage.data.observation.invocationId !== parsed.data.invocationId
            ) {
              db.prepare("INSERT OR IGNORE INTO usage_delivery_quarantine VALUES(?,?,?)").run(
                item.event.eventId,
                JSON.stringify(item.event.payload),
                "USAGE_DELIVERY_INVALID_FACT",
              );
              report(
                Object.assign(new Error("Invalid usage fact retained"), {
                  code: "USAGE_DELIVERY_INVALID_FACT",
                }),
              );
              continue;
            }
            const { observation } = usage.data;
            db.prepare("INSERT OR IGNORE INTO usage_delivery_pending VALUES(?,?)").run(
              observation.observationId,
              JSON.stringify(observation),
            );
          }
          const current = Number(
            (
              db.prepare("SELECT value FROM usage_delivery_metadata WHERE key='cursor'").get() as {
                value: string;
              }
            ).value,
          );
          db.prepare("UPDATE usage_delivery_metadata SET value=? WHERE key='cursor'").run(
            String(Math.max(current, page.nextCursor.sequence)),
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        break;
      }
      case "ack":
        pendingDelta = -Number(
          db.prepare("DELETE FROM usage_delivery_pending WHERE id=?").run(input as string).changes,
        );
        break;
      case "pending":
        value = db.prepare("SELECT id,payload FROM usage_delivery_pending LIMIT 64").all();
        break;
      case "inspect":
        break;
      default:
        throw new Error("Unsupported usage receipt operation.");
    }
    const invalid = db.prepare("SELECT error_code FROM usage_delivery_quarantine LIMIT 1").get() as
      { error_code: string } | undefined;
    return {
      value,
      cursor: cursor(),
      pendingDelta,
      pending:
        operation === "ack"
          ? undefined
          : (
              db.prepare("SELECT COUNT(*) AS count FROM usage_delivery_pending").get() as {
                count: number;
              }
            ).count,
      errorCode: invalid?.error_code,
      errors,
    };
  } finally {
    db.close();
  }
}
