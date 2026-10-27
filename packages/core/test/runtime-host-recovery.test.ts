import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PragmaPaths } from "../src/storage/pragma-paths.ts";
import {
  createRuntimeSessionRecord,
  readRuntimeSessionRecord,
  readRuntimeSessionsForOwners,
  restoreRuntimeSessionRecord,
  updateRuntimeSessionRecord,
} from "../src/runtime/session-record.ts";
import * as hostProcess from "../src/runtime/host-process.ts";
import {
  openRuntimeSessionCatalog,
  runtimeSessionCatalogPath,
} from "../src/storage/migrations/runtime-session-catalog/index.ts";
import { defineExpert, defineRuntimeDriver, moveOwnedStorageToTrash } from "../src/index.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";

const roots: string[] = [];
const children: { child: ChildProcess; exited: Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { child } of children) child.kill("SIGKILL");
  await Promise.all(children.splice(0).map(({ exited }) => exited));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "pragma-host-recovery-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  if (legacy) {
    await mkdir(dirname(runtimeSessionCatalogPath(paths)), { recursive: true });
    await copyFile(
      new URL("./fixtures/runtime-session-catalog-v1-pi.sqlite", import.meta.url),
      runtimeSessionCatalogPath(paths),
    );
  }
  return paths;
}
async function childHost(paths: PragmaPaths, mode?: string) {
  const child = spawn(
    process.execPath,
    [
      "--import=tsx",
      fileURLToPath(new URL("./fixtures/runtime-host-process.mjs", import.meta.url)),
      paths.root,
      ...(mode ? [mode] : []),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  children.push({ child, exited });
  const message = await new Promise<unknown>((resolve, reject) => {
    child.once("message", resolve);
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Host fixture exited before ready: ${stderr}`)));
  });
  return { child, exited, message };
}
function stored(paths: PragmaPaths, id = "session") {
  const database = new DatabaseSync(runtimeSessionCatalogPath(paths));
  try {
    return JSON.parse(
      (
        database
          .prepare("SELECT record_json FROM runtime_sessions WHERE system_session_id = ?")
          .get(id) as { record_json: string }
      ).record_json,
    );
  } finally {
    database.close();
  }
}
async function legacyLease(paths: PragmaPaths, processId?: number) {
  const path = paths.expertSessionLease("historical-pi-owner");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      claimId: "historical-claim",
      processId,
      expiresAt: "2020-01-01T00:00:00.000Z",
    }),
  );
}

describe("in-process Runtime Host recovery", () => {
  it("records Host identity through the managed driver and preserves a live session", async () => {
    const paths = await fixture();
    const runtime = defineRuntimeDriver<never, { id: string }>(
      {
        descriptor: { id: "in-process", kind: "in-process", displayName: "In process" },
        features: createRuntimeTestFeatures({ enabled: ["close"] }),
        createSession: () => ({ id: "native" }),
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn: () => ({ outputText: "done" }),
        mapEvent: () => ({ events: [] }),
        closeSession: async () => {},
      },
      { sessionProcess: "host" },
    );
    const agent = await defineExpert({
      schemaVersion: "pragma.expert/v1",
      id: "expert",
      name: "Expert",
      description: "Test",
      tags: [],
      scope: "test",
      workspace: paths.root,
      pragmaHome: paths.root,
    });
    const session = await openRuntimeSession(runtime, {
      agent,
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      pragmaHome: paths.root,
      systemSessionId: "session",
    });
    try {
      expect(await readRuntimeSessionRecord(paths, "owner", "session")).toMatchObject({
        processState: "running",
        processOwner: { type: "host", processId: process.pid, instanceId: expect.any(String) },
      });
    } finally {
      await session.close();
    }
    expect(stored(paths)).toMatchObject({ processState: "stopped" });
  });
  it("repairs a running record after its actual Host is SIGKILLed", async () => {
    const paths = await fixture();
    const host = await childHost(paths);
    const live = await readRuntimeSessionRecord(paths, "owner", "session");
    expect(live.processState).toBe("running");
    expect(live.processOwner).toMatchObject({ processId: host.child.pid });
    if (process.platform === "darwin" || process.platform === "linux")
      expect(live.processOwner).toMatchObject({ processStartToken: expect.any(String) });
    host.child.kill("SIGKILL");
    await host.exited;
    expect((await readRuntimeSessionsForOwners(paths, ["owner"]))[0]?.processState).toBe("stopped");
    expect(stored(paths).processState).toBe("stopped");
  });
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "distinguishes a reused PID by its OS birth token without killing its current process",
    async () => {
      const paths = await fixture();
      const host = await childHost(paths);
      const live = await readRuntimeSessionRecord(paths, "owner", "session");
      if (live.processOwner?.type !== "host") throw new Error("Host identity missing");
      await createRuntimeSessionRecord({
        paths,
        owner: { type: "expert-session", ownerId: "old-owner" },
        systemSessionId: "old-session",
        agentId: "expert",
        runtime: { id: "pi", kind: "cloud-pi-agent", displayName: "Pi" },
        workspace: paths.root,
        processOwner: {
          ...live.processOwner,
          instanceId: randomUUID(),
          processStartToken: `${live.processOwner.processStartToken}:previous`,
        },
      });
      expect((await readRuntimeSessionRecord(paths, "old-owner", "old-session")).processState).toBe(
        "stopped",
      );
      expect(host.child.signalCode).toBeNull();
      expect((await readRuntimeSessionRecord(paths, "owner", "session")).processState).toBe(
        "running",
      );
    },
  );
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "recognizes a previous Host whose PID now belongs to this process",
    async () => {
      const paths = await fixture();
      const host = await hostProcess.currentRuntimeHostProcess();
      await createRuntimeSessionRecord({
        paths,
        owner: { type: "expert-session", ownerId: "owner" },
        systemSessionId: "session",
        agentId: "expert",
        runtime: { id: "pi", kind: "cloud-pi-agent", displayName: "Pi" },
        workspace: paths.root,
        processOwner: {
          ...host,
          instanceId: randomUUID(),
          processStartToken: `${host.processStartToken}:previous`,
        },
      });
      expect((await readRuntimeSessionRecord(paths, "owner", "session")).processState).toBe(
        "stopped",
      );
    },
  );
  it("preserves a running record when OS inspection is denied", async () => {
    const paths = await fixture();
    const host = await childHost(paths);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect((await readRuntimeSessionRecord(paths, "owner", "session")).processState).toBe(
      "running",
    );
    vi.restoreAllMocks();
    host.child.kill("SIGKILL");
    await host.exited;
  });
  it("does not overwrite a successor Host while a previous Host probe is pending", async () => {
    const paths = await fixture();
    await childHost(paths);
    const live = await readRuntimeSessionRecord(paths, "owner", "session");
    let release!: (status: "dead") => void;
    const pending = new Promise<"dead">((resolve) => {
      release = resolve;
    });
    const probe = vi
      .spyOn(hostProcess, "runtimeHostProcessStatus")
      .mockReturnValueOnce(pending)
      .mockResolvedValue("alive");
    const reading = readRuntimeSessionRecord(paths, "owner", "session");
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    const successor = await hostProcess.currentRuntimeHostProcess();
    await restoreRuntimeSessionRecord({
      paths,
      owner: live.owner,
      systemSessionId: "session",
      agentId: "expert",
      runtime: { id: "pi", kind: "cloud-pi-agent", displayName: "Pi" },
      runtimeSession: { type: "cloud-pi-agent", id: "native" },
      workspace: paths.root,
      processOwner: successor,
    });
    release("dead");
    expect(await reading).toMatchObject({
      processState: "running",
      processOwner: { instanceId: successor.instanceId },
    });
    const retired = await updateRuntimeSessionRecord(paths, live, { processState: "stopped" });
    expect(retired.processOwner).toEqual(live.processOwner);
    await updateRuntimeSessionRecord(paths, retired, { processState: "stopped" });
    expect(stored(paths)).toMatchObject({
      processState: "running",
      processOwner: { instanceId: successor.instanceId },
    });
  });
});

describe("historical Pi writer recovery and migrations", () => {
  it("migrates a real v1 catalog/v3 record and repairs it only after its lease Host exits", async () => {
    const paths = await fixture(true);
    const host = await childHost(await fixture());
    await legacyLease(paths, host.child.pid);
    expect(
      (await readRuntimeSessionRecord(paths, "historical-pi-owner", "historical-pi-session"))
        .processState,
    ).toBe("running");
    host.child.kill("SIGKILL");
    await host.exited;
    expect(
      await readRuntimeSessionRecord(paths, "historical-pi-owner", "historical-pi-session"),
    ).toMatchObject({
      schemaVersion: "pragma.runtime-session/v4",
      processOwner: { type: "legacy-host" },
      processState: "stopped",
    });
    const database = new DatabaseSync(runtimeSessionCatalogPath(paths));
    try {
      const backup = database
        .prepare(
          "SELECT record_json FROM runtime_session_record_backups WHERE system_session_id = ?",
        )
        .get("historical-pi-session") as { record_json: string };
      expect(backup.record_json + "\n").toBe(
        await readFile(new URL("./fixtures/runtime-session-v3-pi.json", import.meta.url), "utf8"),
      );
    } finally {
      database.close();
    }
    const archive = new DatabaseSync(
      join(
        paths.archivesRoot(),
        "storage-migrations",
        "runtime-session-catalog-v2",
        "catalog.sqlite",
      ),
    );
    try {
      expect(
        archive.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get(),
      ).toEqual({ value: "1" });
    } finally {
      archive.close();
    }
    await moveOwnedStorageToTrash({
      paths,
      owner: { type: "mission", id: "historical-mission" },
      sources: [],
      runtimeSessionOwnerIds: ["historical-pi-owner"],
    });
    const deleted = new DatabaseSync(runtimeSessionCatalogPath(paths));
    try {
      expect(
        deleted.prepare("SELECT COUNT(*) AS count FROM runtime_session_record_backups").get(),
      ).toEqual({ count: 0 });
    } finally {
      deleted.close();
    }
  });
  it.each(["missing", "no-pid", "live-expired"] as const)(
    "does not invent a legacy stop from a %s lease",
    async (mode) => {
      const paths = await fixture(true);
      if (mode !== "missing")
        await legacyLease(paths, mode === "live-expired" ? process.pid : undefined);
      expect(
        await readRuntimeSessionRecord(paths, "historical-pi-owner", "historical-pi-session"),
      ).toMatchObject({ processOwner: { type: "legacy-host" }, processState: "running" });
    },
  );
  it.each(["interrupt-catalog-migration", "interrupt-record-migration"])(
    "recovers %s through the real reader after SIGKILL",
    async (mode) => {
      const paths = await fixture(true);
      const host = await childHost(paths, mode);
      host.child.kill("SIGKILL");
      await host.exited;
      const before = new DatabaseSync(runtimeSessionCatalogPath(paths));
      try {
        expect(
          JSON.parse(
            (
              before.prepare("SELECT record_json FROM runtime_sessions").get() as {
                record_json: string;
              }
            ).record_json,
          ).schemaVersion,
        ).toBe("pragma.runtime-session/v3");
      } finally {
        before.close();
      }
      expect(
        await readRuntimeSessionRecord(paths, "historical-pi-owner", "historical-pi-session"),
      ).toMatchObject({ schemaVersion: "pragma.runtime-session/v4", processState: "running" });
      expect(stored(paths, "historical-pi-session").processOwner).toEqual({ type: "legacy-host" });
    },
  );
  it("rejects a future record without rewriting its bytes or creating a row backup", async () => {
    const paths = await fixture();
    const database = await openRuntimeSessionCatalog(paths);
    const future = JSON.stringify({ schemaVersion: "pragma.runtime-session/v99" });
    database
      .prepare("INSERT INTO runtime_sessions VALUES (?, ?, ?, ?, ?)")
      .run("future", "owner", "expert-session", future, new Date().toISOString());
    database.close();
    await expect(readRuntimeSessionRecord(paths, "owner", "future")).rejects.toThrow(
      "unsupported-state-version",
    );
    const check = new DatabaseSync(runtimeSessionCatalogPath(paths));
    try {
      expect(check.prepare("SELECT record_json FROM runtime_sessions").get()).toEqual({
        record_json: future,
      });
      expect(
        check.prepare("SELECT COUNT(*) AS count FROM runtime_session_record_backups").get(),
      ).toEqual({ count: 0 });
    } finally {
      check.close();
    }
  });
});
