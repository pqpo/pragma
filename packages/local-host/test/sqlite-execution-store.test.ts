import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  copyFile,
  rename,
  readdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PragmaPaths,
  ExecutionVersionConflictError,
  encodePragmaPathSegment,
  createPragmaLogger,
  createNoopLoggerProvider,
} from "@pragma/core";
import { type ExecutionRecord, type Invocation, type CanonicalEventEnvelope } from "@pragma/shared";
import { readDeletedExecutionUsageSource } from "../src/execution/deleted-execution-usage.ts";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";

const stores: ReturnType<typeof createSqliteExecutionStore>[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture(
  canonicalEventFeed?: NonNullable<
    Parameters<typeof createSqliteExecutionStore>[0]
  >["canonicalEventFeed"],
) {
  const home = await mkdtemp(join(tmpdir(), "pragma-execution-sqlite-"));
  homes.push(home);
  const store = createSqliteExecutionStore({ pragmaHome: home, canonicalEventFeed });
  stores.push(store);
  const timestamp = new Date().toISOString();
  const definition = { id: "flow", kind: "flow" as const };
  const execution: ExecutionRecord = {
    schemaVersion: "pragma.execution/v12",
    executionId: "execution",
    version: 0,
    kind: "flow",
    definition,
    rootInvocationId: "root",
    status: "running",
    input: null,
    state: {},
    lastAppliedSequence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const root: Invocation = {
    invocationId: "root",
    rootInvocationId: "root",
    contextId: "root-context",
    definition,
    status: "running",
    pendingExpertMessages: [],
    input: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.create(execution, root);
  return { home, store, paths: new PragmaPaths({ pragmaHome: home }) };
}

async function historicalOwner(home: string) {
  const paths = new PragmaPaths({ pragmaHome: home });
  const historical = JSON.parse(
    await readFile(new URL("../../core/test/fixtures/execution-v9.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  await mkdir(paths.executionRoot("v9-run"), { recursive: true });
  for (const [key, file] of [
    ["execution", paths.executionState("v9-run")],
    ["invocations", paths.executionInvocations("v9-run")],
    ["agents", paths.executionAgents("v9-run")],
    ["contexts", paths.executionContexts("v9-run")],
    ["commits", paths.executionCommits("v9-run")],
  ] as const)
    await writeFile(file, JSON.stringify(historical[key]));
  await writeFile(paths.executionEvents("v9-run"), "");
  return paths;
}

describe("Host incremental Execution store", () => {
  it("closes once when callers overlap without terminating other owners' workers", async () => {
    const first = await fixture();
    const second = await fixture();
    await Promise.all([first.store.close(), first.store.close(), first.store.close()]);
    expect((await second.store.get("execution"))?.version).toBe(0);
    await second.store.commit({ executionId: "execution", commitId: "after-close", events: [] });
    expect((await second.store.get("execution"))?.version).toBe(1);
  });
  it("releases failed worker submissions and remains usable", async () => {
    const { store } = await fixture();
    await expect(
      store.commit({
        executionId: "execution",
        commitId: "not-cloneable",
        events: [{ invocationId: "root", type: "progress", data: () => 1 }],
      }),
    ).rejects.toThrow();
    expect((await store.get("execution"))?.version).toBe(0);
    expect(
      (await store.commit({ executionId: "execution", commitId: "valid-after-failure" })).execution
        .version,
    ).toBe(1);
  });
  it("archives only terminal owners and retains their indexed history", async () => {
    const { store } = await fixture();
    await expect(store.archive("execution")).rejects.toThrow("non-terminal Execution");
    await store.commit({
      executionId: "execution",
      commitId: "complete",
      executionPatch: { status: "succeeded" },
      invocationPatches: [{ invocationId: "root", patch: { status: "succeeded" } }],
      events: [
        { eventId: "terminal", invocationId: "root", type: "execution.succeeded", data: {} },
      ],
    });
    await store.archive("execution");
    expect((await store.readEvents("execution"))[0]?.eventId).toBe("terminal");
  });
  it("refuses future database formats without initializing or rewriting them", async () => {
    const { store, paths } = await fixture();
    const db = new DatabaseSync(paths.executionDatabase("execution"));
    db.exec("PRAGMA user_version=999;");
    db.close();
    const original = await readFile(paths.executionDatabase("execution"));
    await expect(store.get("execution")).rejects.toThrow("Unsupported Execution database version");
    expect(await readFile(paths.executionDatabase("execution"))).toEqual(original);
    expect(await store.get("unrelated")).toBeUndefined();
  });
  it("fences competing commits from separate Host processes", async () => {
    const { store, home } = await fixture();
    const child = fileURLToPath(
      new URL("./fixtures/sqlite-execution-process.mjs", import.meta.url),
    );
    const results = await Promise.all(
      ["process-a", "process-b"].map(async (id) => {
        const result = await promisify(execFile)(process.execPath, [child, home, id]);
        return JSON.parse(result.stdout) as { ok: boolean; name?: string };
      }),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.name).toBe("ExecutionVersionConflictError");
    expect((await store.get("execution"))?.version).toBe(1);
    expect(await store.readEvents("execution")).toHaveLength(1);
  });
  it("retries bounded database contention without losing the commit", async () => {
    const { store, paths } = await fixture();
    const competing = new DatabaseSync(paths.executionDatabase("execution"));
    competing.exec("BEGIN IMMEDIATE;");
    const release = setTimeout(() => competing.exec("ROLLBACK;"), 250);
    try {
      const result = await store.commit({
        executionId: "execution",
        commitId: "busy-retry",
        events: [{ eventId: "busy-event", invocationId: "root", type: "progress", data: 1 }],
      });
      expect(result.execution.version).toBe(1);
      expect((await store.readEvents("execution")).map((event) => event.eventId)).toEqual([
        "busy-event",
      ]);
    } finally {
      clearTimeout(release);
      competing.close();
    }
  });
  it("converts writer-produced v10 pending handoffs without losing canonical identities", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-historical-handoff-"));
    homes.push(home);
    const historical = JSON.parse(
      await readFile(
        new URL("../../core/test/fixtures/execution-handoff-v10.json", import.meta.url),
        "utf8",
      ),
    ) as { files: Record<string, string> };
    for (const [relative, contents] of Object.entries(historical.files)) {
      const file = join(home, relative);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    const store = createSqliteExecutionStore({ pragmaHome: home });
    stores.push(store);
    const snapshot = await store.exportSnapshot("historical-handoff");
    expect(snapshot.execution.status).toBe("succeeded");
    expect(snapshot.execution.schemaVersion).toBe("pragma.execution/v12");
    expect(snapshot.commits[0]?.committedVersion).toBe(1);
    const source = Object.entries(historical.files).find(([file]) => file.includes("/handoffs/"))!;
    const original = JSON.parse(source[1]) as { events: CanonicalEventEnvelope[] };
    expect(snapshot.pendingCanonicalEvents).toEqual(original.events);
    const paths = new PragmaPaths({ pragmaHome: home });
    expect(
      await readFile(
        join(
          paths.executionStorageBackup("historical-handoff"),
          "handoffs",
          source[0].split("/").at(-1)!,
        ),
        "utf8",
      ),
    ).toBe(source[1]);
    expect((await store.readEvents("historical-handoff"))[0]?.eventId).toBe("historic-terminal");
  });
  it("commits changes, preserves idempotency and uses indexed cursor pages", async () => {
    const { store, home } = await fixture();
    const request = {
      executionId: "execution",
      commitId: "first",
      expectedVersion: 0,
      events: [{ eventId: "e1", invocationId: "root", type: "progress", data: { value: 1 } }],
    };
    const result = await store.commit(request);
    expect(result.execution.version).toBe(1);
    expect(result.invocations).toEqual([]);
    expect(await store.commit(request)).toEqual(result);
    await expect(
      store.commit({
        ...request,
        events: [{ eventId: "e1", invocationId: "root", type: "progress", data: { value: 2 } }],
      }),
    ).rejects.toThrow("idempotency conflict");
    await expect(
      store.commit({ executionId: "execution", commitId: "cas", expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ExecutionVersionConflictError);
    await store.commit({
      executionId: "execution",
      commitId: "second",
      events: [{ eventId: "e2", invocationId: "root", type: "progress", data: 2 }],
    });
    expect(
      (await store.readEvents("execution", undefined, 1)).map((value) => value.eventId),
    ).toEqual(["e1"]);
    expect(
      (await store.readEvents("execution", { executionId: "execution", sequence: 1 }, 1)).map(
        (value) => value.eventId,
      ),
    ).toEqual(["e2"]);
    const exported = await store.exportSnapshot("execution");
    expect(exported.execution.version).toBe(2);
    expect(exported.events.map((event) => event.eventId)).toEqual(["e1", "e2"]);
    expect(exported.commits.map((receipt) => receipt.commitId)).toEqual(["first", "second"]);
    expect(exported.pendingCanonicalEvents).toEqual([]);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = createSqliteExecutionStore({ pragmaHome: home });
    stores.push(reopened);
    expect((await reopened.get("execution"))?.version).toBe(2);
  });

  it("isolates concurrent writers and rejects conflicting final transitions", async () => {
    const { store, home } = await fixture();
    const second = createSqliteExecutionStore({ pragmaHome: home });
    stores.push(second);
    const results = await Promise.allSettled([
      store.commit({ executionId: "execution", commitId: "a", expectedVersion: 0 }),
      second.commit({ executionId: "execution", commitId: "b", expectedVersion: 0 }),
    ]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    await store.commit({
      executionId: "execution",
      commitId: "finish",
      executionPatch: { status: "succeeded" },
    });
    await expect(
      second.commit({
        executionId: "execution",
        commitId: "bad",
        executionPatch: { status: "failed" },
      }),
    ).rejects.toThrow("cannot transition");
  });

  it("converts a real historical v9 fixture through the existing migration chain and retains backup", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-execution-history-"));
    homes.push(home);
    const paths = new PragmaPaths({ pragmaHome: home });
    const historical = JSON.parse(
      await readFile(
        new URL("../../core/test/fixtures/execution-v9.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    await mkdir(paths.executionRoot("v9-run"), { recursive: true });
    for (const [key, file] of [
      ["execution", paths.executionState("v9-run")],
      ["invocations", paths.executionInvocations("v9-run")],
      ["agents", paths.executionAgents("v9-run")],
      ["contexts", paths.executionContexts("v9-run")],
      ["commits", paths.executionCommits("v9-run")],
    ] as const)
      await writeFile(file, JSON.stringify(historical[key]));
    await writeFile(paths.executionEvents("v9-run"), "");
    const store = createSqliteExecutionStore({ pragmaHome: home });
    stores.push(store);
    expect(await store.get("v9-run")).toMatchObject({
      schemaVersion: "pragma.execution/v12",
      executionId: "v9-run",
    });
    expect(await store.getInvocation("v9-run", "root")).toMatchObject({
      input: { text: "hello", attachments: [] },
    });
    const marker = await readFile(paths.executionStorageAuthority("v9-run"), "utf8");
    await store.get("v9-run");
    expect(await readFile(paths.executionStorageAuthority("v9-run"), "utf8")).toBe(marker);
    expect(
      await readFile(join(paths.executionStorageBackup("v9-run"), "execution.json"), "utf8"),
    ).toContain("pragma.execution/v9");
  });

  it.each(["journal", "partial-import", "closed-import", "renamed-import", "authority"] as const)(
    "replays conversion after %s interruption",
    async (boundary) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-conversion-replay-"));
      homes.push(home);
      const paths = await historicalOwner(home);
      if (
        boundary === "closed-import" ||
        boundary === "renamed-import" ||
        boundary === "authority"
      ) {
        const initial = createSqliteExecutionStore({ pragmaHome: home });
        await initial.get("v9-run");
        await initial.close();
        if (boundary === "closed-import") {
          await copyFile(
            paths.executionDatabase("v9-run"),
            `${paths.executionDatabase("v9-run")}.converting`,
          );
          await rm(paths.executionDatabase("v9-run"));
        }
        if (boundary !== "authority") await rm(paths.executionStorageAuthority("v9-run"));
      }
      await writeFile(
        paths.executionStorageConversion("v9-run"),
        JSON.stringify({
          schemaVersion: "pragma.execution-storage-conversion/v1",
          executionId: "v9-run",
          handoffNames: [],
        }),
      );
      if (boundary === "partial-import")
        await writeFile(`${paths.executionDatabase("v9-run")}.converting`, "incomplete import");
      const store = createSqliteExecutionStore({ pragmaHome: home });
      stores.push(store);
      expect(await store.get("v9-run")).toMatchObject({
        schemaVersion: "pragma.execution/v12",
        executionId: "v9-run",
      });
      expect(await store.getInvocation("v9-run", "root")).toMatchObject({
        input: { text: "hello", attachments: [] },
      });
      await expect(readFile(paths.executionStorageConversion("v9-run"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await store.commit({
        executionId: "v9-run",
        commitId: "after-recovery",
        events: [{ invocationId: "root", type: "progress", data: 1 }],
      });
      await store.delete("v9-run");
      expect(await store.get("v9-run")).toBeUndefined();
    },
  );

  it("replays initialization before the database exists", async () => {
    const { store, paths } = await fixture();
    const record = await store.get("execution");
    const root = await store.getInvocation("execution", "root");
    await writeFile(
      paths.executionStorageInitialization("execution"),
      JSON.stringify({
        schemaVersion: "pragma.execution-storage-initialization/v1",
        executionId: "execution",
        record,
        root,
      }),
    );
    await rm(paths.executionStorageAuthority("execution"));
    await rm(paths.executionDatabase("execution"));
    expect(await store.get("execution")).toEqual(record);
    expect(await store.getInvocation("execution", "root")).toEqual(root);
  });

  it("rejects future authority without modifying the owner or blocking another owner", async () => {
    const { store, paths } = await fixture();
    await writeFile(
      paths.executionStorageAuthority("execution"),
      JSON.stringify({
        schemaVersion: "pragma.execution-storage/v99",
        engine: "sqlite",
        executionId: "execution",
      }),
    );
    await expect(store.get("execution")).rejects.toThrow();
    expect(await store.get("unrelated")).toBeUndefined();
    expect(await readFile(paths.executionStorageAuthority("execution"), "utf8")).toContain("v99");
  });

  it.each(["pending", "handoff"] as const)(
    "isolates invalid %s filenames while recovering a normal owner",
    async (kind) => {
      let unavailable = true;
      const delivered = new Map<string, CanonicalEventEnvelope>();
      const append = async (events: readonly CanonicalEventEnvelope[]) => {
        if (unavailable) throw new Error("offline");
        for (const event of events) delivered.set(event.eventId, event);
      };
      const { store, paths, home } = await fixture({ append } as NonNullable<
        Parameters<typeof createSqliteExecutionStore>[0]
      >["canonicalEventFeed"]);
      await store.commit({
        executionId: "execution",
        commitId: "source",
        events: [{ eventId: "event", invocationId: "root", type: "progress", data: 1 }],
      });
      await expect(store.close()).rejects.toThrow("offline");
      stores.splice(stores.indexOf(store), 1);
      const directory =
        kind === "pending"
          ? paths.executionCanonicalPendingRoot()
          : paths.canonicalEventHandoffsRoot();
      await mkdir(directory, { recursive: true });
      const invalid = join(directory, "!invalid.json");
      await writeFile(invalid, "original damaged source");
      unavailable = false;
      const logger = createPragmaLogger(createNoopLoggerProvider(), { component: "test" });
      const warn = vi.spyOn(logger, "warn");
      const restarted = createSqliteExecutionStore({
        pragmaHome: home,
        canonicalEventFeed: { append } as NonNullable<
          Parameters<typeof createSqliteExecutionStore>[0]
        >["canonicalEventFeed"],
        logger,
      });
      stores.push(restarted);
      expect(await restarted.recoverPendingCanonicalEvents()).toMatchObject({
        recovered: 1,
        pending: 0,
        failed: 0,
        quarantined: 1,
      });
      expect(delivered.size).toBe(1);
      await expect(readFile(invalid)).rejects.toMatchObject({ code: "ENOENT" });
      const names = await readdir(paths.canonicalEventHandoffQuarantineRoot());
      expect(
        await readFile(join(paths.canonicalEventHandoffQuarantineRoot(), names[0]!), "utf8"),
      ).toBe("original damaged source");
      expect(warn).toHaveBeenCalledWith(
        "execution.canonical_source_invalid",
        expect.any(String),
        expect.objectContaining({ errorCode: "execution_canonical_source_invalid" }),
      );
      expect(await restarted.recoverPendingCanonicalEvents()).toMatchObject({
        recovered: 0,
        pending: 0,
        quarantined: 1,
      });
    },
  );

  it("rotates past a failed recovery batch after restart and backs off failed owners", async () => {
    const append = vi.fn(async () => {
      throw new Error("offline");
    });
    const { store, paths, home } = await fixture({ append } as NonNullable<
      Parameters<typeof createSqliteExecutionStore>[0]
    >["canonicalEventFeed"]);
    await store.commit({
      executionId: "execution",
      commitId: "source",
      events: [{ eventId: "event", invocationId: "root", type: "progress", data: 1 }],
    });
    await expect(store.close()).rejects.toThrow("offline");
    stores.splice(stores.indexOf(store), 1);
    const unavailable = Array.from(
      { length: 64 },
      (_, index) => `a-${String(index).padStart(2, "0")}`,
    );
    for (const id of unavailable)
      await writeFile(paths.executionCanonicalPending(id), JSON.stringify({ executionId: id }));
    const delivered = vi.fn(async () => {});
    const restarted = createSqliteExecutionStore({
      pragmaHome: home,
      canonicalEventFeed: { append: delivered } as NonNullable<
        Parameters<typeof createSqliteExecutionStore>[0]
      >["canonicalEventFeed"],
    });
    stores.push(restarted);
    expect(await restarted.recoverPendingCanonicalEvents()).toMatchObject({
      recovered: 0,
      failed: 64,
      pending: 65,
    });
    expect(delivered).not.toHaveBeenCalled();
    expect(await restarted.recoverPendingCanonicalEvents()).toMatchObject({
      recovered: 1,
      pending: 64,
      failed: 64,
    });
    expect(delivered).toHaveBeenCalledOnce();
    // Failures are retained for repair; cleanup avoids deliberately failing close.
    for (const id of unavailable) await rm(paths.executionCanonicalPending(id));
    expect(await restarted.recoverPendingCanonicalEvents()).toMatchObject({
      failed: 0,
      pending: 0,
    });
  });

  it("reads writer-produced historical JSON Trash without creating a live owner", async () => {
    const { home, paths } = await fixture();
    await historicalOwner(home);
    const deletionId = randomUUID();
    const target = join(paths.trashRoot(), deletionId, "executions");
    await mkdir(target, { recursive: true });
    await rename(paths.executionRoot("v9-run"), join(target, encodePragmaPathSegment("v9-run")));
    const source = await readDeletedExecutionUsageSource(paths, deletionId, "v9-run");
    expect(source?.invocations.length).toBeGreaterThan(0);
    await expect(readFile(paths.executionState("v9-run"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const missingDeletionId = randomUUID();
    expect(
      await readDeletedExecutionUsageSource(paths, missingDeletionId, "v9-run"),
    ).toBeUndefined();
    await expect(readdir(join(paths.trashRoot(), missingDeletionId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains canonical source after a slow or failed delivery and retries idempotently", async () => {
    let unavailable = true;
    const envelopes = new Map<string, CanonicalEventEnvelope>();
    const canonical = {
      append: async (events: readonly CanonicalEventEnvelope[]) => {
        if (unavailable) throw new Error("feed offline");
        for (const event of events) envelopes.set(event.eventId, event);
      },
    };
    const { store, paths } = await fixture(
      canonical as NonNullable<
        Parameters<typeof createSqliteExecutionStore>[0]
      >["canonicalEventFeed"],
    );
    await store.commit({
      executionId: "execution",
      commitId: "source",
      events: [{ eventId: "event", invocationId: "root", type: "progress", data: 1 }],
    });
    expect((await store.get("execution"))?.version).toBe(1);
    await expect(store.drainCanonicalEvents()).rejects.toThrow("feed offline");
    expect((await store.inspectCanonicalEventDelivery()).pending).toBe(1);
    unavailable = false;
    await store.drainCanonicalEvents();
    await store.drainCanonicalEvents();
    expect(envelopes.size).toBe(1);
    expect((await store.inspectCanonicalEventDelivery()).pending).toBe(0);
    const registration = await readFile(
      paths.executionCanonicalIdleRegistration("execution"),
      "utf8",
    );
    expect(JSON.parse(registration)).toMatchObject({ executionId: "execution", engine: "sqlite" });
    // A crash after registering, before the SQL transaction, leaves no source facts.
    await rename(
      paths.executionCanonicalIdleRegistration("execution"),
      paths.executionCanonicalPending("execution"),
    );
    await store.drainCanonicalEvents();
    expect((await store.inspectCanonicalEventDelivery()).pending).toBe(0);
    await store.commit({
      executionId: "execution",
      commitId: "reused",
      events: [{ eventId: "reused", invocationId: "root", type: "progress", data: 2 }],
    });
    await store.drainCanonicalEvents();
    expect(envelopes.size).toBe(2);
    await store.delete("execution");
    expect(await store.get("execution")).toBeUndefined();
    await expect(
      readFile(paths.executionCanonicalIdleRegistration("execution")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drains bounded batches including commits arriving during delivery", async () => {
    const delivered = new Set<string>();
    const batchSizes: number[] = [];
    const canonical = {
      append: async (events: readonly CanonicalEventEnvelope[]) => {
        batchSizes.push(events.length);
        if (batchSizes.length === 1)
          await store.commit({
            executionId: "execution",
            commitId: "concurrent",
            events: [{ eventId: "concurrent", invocationId: "root", type: "progress", data: 1 }],
          });
        for (const event of events) {
          expect(delivered.has(event.eventId)).toBe(false);
          delivered.add(event.eventId);
        }
      },
    };
    const { store } = await fixture(
      canonical as NonNullable<
        Parameters<typeof createSqliteExecutionStore>[0]
      >["canonicalEventFeed"],
    );
    await store.commit({
      executionId: "execution",
      commitId: "batch",
      events: Array.from({ length: 130 }, (_, index) => ({
        eventId: `event-${index}`,
        invocationId: "root",
        type: "progress",
        data: index,
      })),
    });
    await store.drainCanonicalEvents();
    expect(delivered.size).toBe(131);
    expect(batchSizes.every((size) => size <= 64)).toBe(true);
    expect((await store.inspectCanonicalEventDelivery()).pending).toBe(0);
    await store.drainCanonicalEvents();
    expect(delivered.size).toBe(131);
  });

  it("flushes an accepted final commit when close overlaps its scheduled delivery", async () => {
    const delivered = new Set<string>();
    const canonical = {
      append: async (events: readonly CanonicalEventEnvelope[]) => {
        for (const event of events) delivered.add(event.sourceRef.id);
      },
    };
    const { store } = await fixture(
      canonical as NonNullable<
        Parameters<typeof createSqliteExecutionStore>[0]
      >["canonicalEventFeed"],
    );
    const finalCommit = store.commit({
      executionId: "execution",
      commitId: "last-accepted",
      events: [{ eventId: "last-accepted", invocationId: "root", type: "progress", data: 1 }],
    });
    await Promise.all([finalCommit, store.close()]);
    expect(delivered).toEqual(new Set(["last-accepted"]));
  });

  it("does not resurrect delivery after deleting an owner with a scheduled wake", async () => {
    let deleted = false;
    let resurrected = false;
    const canonical = {
      append: async () => {
        if (deleted) resurrected = true;
      },
    };
    const { store } = await fixture(
      canonical as NonNullable<
        Parameters<typeof createSqliteExecutionStore>[0]
      >["canonicalEventFeed"],
    );
    await store.commit({
      executionId: "execution",
      commitId: "before-delete",
      events: [{ eventId: "before-delete", invocationId: "root", type: "progress", data: 1 }],
    });
    await store.delete("execution");
    deleted = true;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(resurrected).toBe(false);
    expect(await store.get("execution")).toBeUndefined();
  });

  it("retains a foreign process source commit during delivery confirmation", async () => {
    const delivered = new Set<string>();
    let first = true;
    const child = fileURLToPath(
      new URL("./fixtures/sqlite-execution-process.mjs", import.meta.url),
    );
    const canonical = {
      append: async (events: readonly CanonicalEventEnvelope[]) => {
        if (first) {
          first = false;
          const result = await promisify(execFile)(process.execPath, [
            child,
            home,
            "foreign",
            "source",
          ]);
          expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, version: 2 });
        }
        for (const event of events) delivered.add(event.eventId);
      },
    };
    const { store, home } = await fixture(
      canonical as NonNullable<
        Parameters<typeof createSqliteExecutionStore>[0]
      >["canonicalEventFeed"],
    );
    await store.commit({
      executionId: "execution",
      commitId: "first",
      events: [{ eventId: "first", invocationId: "root", type: "progress", data: 1 }],
    });
    await store.drainCanonicalEvents();
    expect(delivered.size).toBe(2);
    expect((await store.inspectCanonicalEventDelivery()).pending).toBe(0);
    expect((await store.exportSnapshot("execution")).pendingCanonicalEvents).toEqual([]);
  });

  it("imports current file receipts without rewriting the JSON authority after conversion", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-execution-json-"));
    homes.push(home);
    const historical = JSON.parse(
      await readFile(new URL("./fixtures/execution-file-v12.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const fixturePaths = new PragmaPaths({ pragmaHome: home });
    await mkdir(fixturePaths.executionRoot("current"), { recursive: true });
    for (const [name, file] of [
      ["execution", fixturePaths.executionState("current")],
      ["invocations", fixturePaths.executionInvocations("current")],
      ["agents", fixturePaths.executionAgents("current")],
      ["contexts", fixturePaths.executionContexts("current")],
      ["commits", fixturePaths.executionCommits("current")],
    ])
      await writeFile(file!, JSON.stringify(historical[name!]));
    await writeFile(
      fixturePaths.executionEvents("current"),
      (historical.events as unknown[]).map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    const request = {
      executionId: "current",
      commitId: "old",
      events: [{ eventId: "one", invocationId: "root", type: "progress", data: 1 }],
    };
    const paths = new PragmaPaths({ pragmaHome: home });
    const original = await readFile(paths.executionState("current"), "utf8");
    const store = createSqliteExecutionStore({ pragmaHome: home });
    stores.push(store);
    expect((await store.commit(request)).events[0]?.eventId).toBe("one");
    await store.commit({
      executionId: "current",
      commitId: "new",
      events: [{ eventId: "two", invocationId: "root", type: "progress", data: 2 }],
    });
    expect(await readFile(paths.executionState("current"), "utf8")).toBe(original);
    expect((await store.get("current"))?.version).toBe(2);
  });
});
