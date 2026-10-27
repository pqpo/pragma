import process from "node:process";
import { setInterval } from "node:timers";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "../../src/storage/pragma-paths.ts";
import { currentRuntimeHostProcess } from "../../src/runtime/host-process.ts";
import {
  createRuntimeSessionRecord,
  updateRuntimeSessionRecord,
} from "../../src/runtime/session-record.ts";
import {
  openRuntimeSessionCatalog,
  upgradeRuntimeSessionCatalogRecord,
  runtimeSessionCatalogPath,
} from "../../src/storage/migrations/runtime-session-catalog/index.ts";

const paths = new PragmaPaths({ pragmaHome: process.argv[2] });
if (process.argv[3] === "interrupt-record-migration") {
  const database = await openRuntimeSessionCatalog(paths);
  database.exec("BEGIN IMMEDIATE");
  const row = database
    .prepare("SELECT record_json FROM runtime_sessions WHERE system_session_id = ?")
    .get("historical-pi-session");
  upgradeRuntimeSessionCatalogRecord(database, row.record_json);
  process.send?.({ ready: true });
} else if (process.argv[3] === "interrupt-catalog-migration") {
  const database = new DatabaseSync(runtimeSessionCatalogPath(paths));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA cache_size = 1; BEGIN IMMEDIATE");
  const { RUNTIME_SESSION_CATALOG_V2_SCHEMA_SQL } =
    await import("../../src/storage/migrations/runtime-session-catalog/schemas/v2.ts");
  database.exec(RUNTIME_SESSION_CATALOG_V2_SCHEMA_SQL);
  database.exec("UPDATE metadata SET value = '2' WHERE key = 'schema_version'");
  process.send?.({ ready: true });
} else {
  const host = await currentRuntimeHostProcess();
  const record = await createRuntimeSessionRecord({
    paths,
    owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
    systemSessionId: "session",
    agentId: "expert",
    runtime: { id: "pi", kind: "cloud-pi-agent", displayName: "Pi" },
    workspace: paths.root,
    processOwner: host,
  });
  await updateRuntimeSessionRecord(paths, record, {
    processState: "running",
    runtimeSessionRef: { type: "cloud-pi-agent", id: "native" },
  });
  process.send?.(host);
}
setInterval(() => {}, 1000);
