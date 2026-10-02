import { ExecutionStorageAuthoritySchema } from "./execution-storage-export.ts";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PragmaPaths,
  encodePragmaPathSegment,
  readLegacyExecutionUsageSource,
  withFileLock,
} from "@pragma/core";
import {
  ExecutionEventSchema,
  InvocationSchema,
  type ExecutionEvent,
  type Invocation,
} from "@pragma/shared";
import { acquireHostStoragePool } from "../host-storage-pool.ts";

type UsageSource = {
  readonly events: readonly ExecutionEvent[];
  readonly invocations: readonly Invocation[];
};

/** Host worker reads only usage facts from the owned Trash snapshot. */
export async function readDeletedExecutionUsageSource(
  paths: PragmaPaths,
  deletionId: string,
  executionId: string,
): Promise<UsageSource | undefined> {
  const pool = acquireHostStoragePool();
  try {
    return await pool.clients[1]!.call<UsageSource | undefined>(
      "deleted-usage-source",
      executionId,
      { deletionId },
      false,
      paths.root,
    );
  } finally {
    await pool.close();
  }
}

/** Worker-only implementation. The GC barrier keeps the source alive during the read. */
export async function readDeletedExecutionUsageSourceInWorker(
  paths: PragmaPaths,
  deletionId: string,
  executionId: string,
): Promise<UsageSource | undefined> {
  const trash = join(paths.trashRoot(), deletionId);
  // Deletion IDs are generated journal identities, never arbitrary path input.
  if (!/^[a-zA-Z0-9_-]+$/.test(deletionId)) throw new Error("Invalid storage deletion identity.");
  class TrashPaths extends PragmaPaths {
    override executionRoot(id: string) {
      return join(trash, "executions", encodePragmaPathSegment(id));
    }
    override executionArchive(id: string) {
      return join(trash, "execution-archives", `${encodePragmaPathSegment(id)}.jsonl.gz`);
    }
  }
  const source = new TrashPaths({ pragmaHome: trash });
  return await withFileLock(
    paths.storageGcLock(),
    async () => {
      if (existsSync(source.executionStorageAuthority(executionId))) {
        const marker = ExecutionStorageAuthoritySchema.parse(
          JSON.parse(await readFile(source.executionStorageAuthority(executionId), "utf8")),
        );
        if (marker.executionId !== executionId)
          throw new Error("Deleted Execution authority owner mismatch.");
        const db = new DatabaseSync(source.executionDatabase(executionId), { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout=100;");
          if (
            (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version !== 1
          )
            throw new Error("Unsupported Execution database version.");
          const events = (
            db
              .prepare(
                "SELECT payload FROM events WHERE json_extract(payload,'$.type')='runtime.usage.observed' ORDER BY sequence",
              )
              .all() as { payload: string }[]
          ).map((row) => ExecutionEventSchema.parse(JSON.parse(row.payload)));
          const invocations = (
            db.prepare("SELECT payload FROM invocations ORDER BY rowid").all() as {
              payload: string;
            }[]
          ).map((row) => InvocationSchema.parse(JSON.parse(row.payload)));
          return { events, invocations };
        } finally {
          db.close();
        }
      }
      return await readLegacyExecutionUsageSource(source, executionId);
    },
    { operation: "mission-deletion.usage-source" },
  );
}
