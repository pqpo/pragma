import { missionDeletionMigrationChain } from "../src/missions/deletion-migrations/index.ts";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PragmaPaths,
  encodePragmaPathSegment,
  createPragmaLogger,
  moveOwnedStorageToTrash,
  createRuntimeSessionRecord,
  readRuntimeSessionRecord,
} from "@pragma/core";
import {
  createMissionDeletionService,
  MissionDeletionSourceExpiredError,
  type MissionDeletionPorts,
  MISSION_DELETION_MAX_RETRIES,
} from "../src/missions/deletion.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(overrides: Partial<MissionDeletionPorts> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pragma-deletion-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  const ports: MissionDeletionPorts = {
    usage: vi.fn(async () => {}),
    memory: vi.fn(async () => {}),
    drafts: vi.fn(async () => {}),
    claims: vi.fn(async () => {}),
    settlement: vi.fn(async () => {}),
    ...overrides,
  };
  const makeService = (stepTimeoutMs = 20) =>
    createMissionDeletionService({
      paths,
      ports,
      logger: createPragmaLogger(undefined, { component: "deletion-test" }),
      stepTimeoutMs,
    });
  const rawService = makeService();
  const service = {
    ...rawService,
    commit: async (id: string) => {
      const current = await rawService.read(id);
      await moveOwnedStorageToTrash({
        paths,
        deletionId: current!.deletionId,
        owner: { type: "mission", id },
        sources: [],
      });
      await rawService.commit(id);
    },
  };
  const record = await service.prepare({
    missionId: "mission",
    executionIds: ["execution"],
    // Ordinary cleanup fixtures own no external child. Orphan-process cases
    // explicitly replace this inventory; do not race `ps` against a 20ms deadline.
    payload: { title: "delete", runtimeProcessOwnerIds: [] },
  });
  return { paths, ports, service, record, makeService };
}
describe("Mission post-commit deletion", () => {
  it("runs no cleanup before commit and deduplicates preparation", async () => {
    const target = await fixture();
    expect(
      (
        await target.service.prepare({
          missionId: "mission",
          executionIds: ["execution"],
          payload: {},
        })
      ).deletionId,
    ).toBe(target.record.deletionId);
    await target.service.runOnce();
    for (const port of Object.values(target.ports)) expect(port).not.toHaveBeenCalled();
    expect((await target.service.read("mission"))?.retryAttempts).toBe(0);
    await target.service.commit("mission");
    await target.service.runOnce();
    expect((await target.service.read("mission"))?.phase).toBe("completed");
    await target.makeService().runOnce();
    for (const port of Object.values(target.ports)) expect(port).toHaveBeenCalledOnce();
  });
  it.runIf(process.platform === "linux" || process.platform === "darwin")(
    "resumes orphan cleanup from durable owner IDs after Host restart",
    async () => {
      const target = await fixture();
      await target.service.updateOwners("mission", ["execution"], { sessionIds: ["session"] });
      await target.service.commit("mission");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env: {
          ...process.env,
          CODEX_HOME: target.paths.ownedRuntimeRoot("session", "native", "codex"),
        },
        stdio: "ignore",
      });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        const restarted = target.makeService();
        await restarted.runOnce();
        await exited;
        expect(child.signalCode).toBe("SIGTERM");
        const record = (await restarted.read("mission"))!;
        expect(record.phase).toBe("committed");
        expect(record.steps.settlement.done).toBe(false);
        await writeFile(
          target.paths.missionDeletion("mission"),
          JSON.stringify({
            ...record,
            steps: { ...record.steps, settlement: { ...record.steps.settlement, nextAt: 0 } },
          }),
        );
        // The retry must allow a real process inventory to finish under CI load.
        await target.makeService(1_000).runOnce();
        expect((await target.service.read("mission"))?.phase).toBe("completed");
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    },
  );
  it("recovers the crash between storage commit and Host progress", async () => {
    const target = await fixture();
    const source = join(target.paths.root, "source");
    await mkdir(source);
    await writeFile(join(source, "input"), "data");
    await moveOwnedStorageToTrash({
      paths: target.paths,
      deletionId: target.record.deletionId,
      owner: { type: "mission", id: "mission" },
      sources: [{ label: "mission", path: source }],
    });
    const recovered = target.makeService();
    await recovered.runOnce();
    expect((await recovered.read("mission"))?.phase).toBe("completed");
    expect(target.ports.usage).toHaveBeenCalledOnce();
  });
  it("recovers Host notification failure after storage has committed", async () => {
    const target = await fixture();
    await expect(
      moveOwnedStorageToTrash({
        paths: target.paths,
        deletionId: target.record.deletionId,
        owner: { type: "mission", id: "mission" },
        sources: [],
        onCommitted: async () => {
          throw new Error("Host progress unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "STORAGE_DELETION_COMMITTED_FINALIZATION_PENDING" });
    await target.makeService().runOnce();
    expect((await target.service.read("mission"))?.phase).toBe("completed");
  });
  it("shares concurrent runs and does not retry an outstanding timed-out callback", async () => {
    let release!: () => void;
    const usage = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const target = await fixture({ usage });
    await target.service.commit("mission");
    await Promise.all([target.service.runOnce(), target.service.runOnce()]);
    expect(usage).toHaveBeenCalledOnce();
    await target.service.runOnce();
    expect(usage).toHaveBeenCalledOnce();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  it("replays a rename before progress or catalog preparation was saved", async () => {
    const target = await fixture();
    const paths = target.paths;
    await createRuntimeSessionRecord({
      paths,
      owner: { type: "flow-execution", ownerId: "execution" },
      systemSessionId: "native",
      agentId: "expert",
      runtime: { id: "fake", kind: "fake", displayName: "Fake" },
      workspace: paths.root,
    });
    const source = paths.executionRoot("execution");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "input"), "kept");
    const destination = join(
      paths.trashRoot(),
      target.record.deletionId,
      "executions",
      "execution",
    );
    await mkdir(join(destination, ".."), { recursive: true });
    await mkdir(paths.deletionJournalRoot(), { recursive: true });
    await writeFile(
      join(paths.deletionJournalRoot(), `${target.record.deletionId}.json`),
      JSON.stringify({
        schemaVersion: "pragma.storage-deletion/v1",
        deletionId: target.record.deletionId,
        owner: { type: "mission", id: "mission" },
        status: "moving",
        moved: [],
        runtimeSessionOwnerIds: ["execution"],
        sources: [{ label: "executions/execution", path: source }],
        startedAt: new Date().toISOString(),
      }),
    );
    await rename(source, destination);
    await target.makeService().runOnce();
    expect((await target.service.read("mission"))?.phase).toBe("completed");
    expect(await readFile(join(destination, "input"), "utf8")).toBe("kept");
    await expect(readRuntimeSessionRecord(paths, "execution", "native")).rejects.toThrow(
      "not found",
    );
  });
  it("isolates an indefinitely blocked Usage step and retries errors independently", async () => {
    const usage = vi.fn(async () => await new Promise<void>(() => {}));
    const target = await fixture({ usage });
    await target.service.commit("mission");
    await target.service.runOnce();
    const record = await target.service.read("mission");
    expect(record?.phase).toBe("committed");
    expect(record?.steps.usage).toMatchObject({
      done: false,
      attempts: 1,
      errorCode: "MISSION_DELETE_CLEANUP_RETRY_PENDING",
    });
    for (const step of ["memory", "drafts", "claims", "settlement"] as const)
      expect(target.ports[step]).toHaveBeenCalledOnce();
    expect(target.service.inspect().state).toBe("degraded");
    target.service.close();
  });
  it("ends expired Usage without preventing the other cleanup or pinning trash", async () => {
    const target = await fixture({
      usage: async () => {
        throw new MissionDeletionSourceExpiredError();
      },
    });
    await target.service.commit("mission");
    await target.service.runOnce();
    const record = await target.service.read("mission");
    expect(record?.phase).toBe("completed");
    expect(record?.steps.usage.errorCode).toBe("MISSION_DELETE_USAGE_SOURCE_EXPIRED");
    expect(record?.payload).toEqual({});
  });
  it("still runs native settlement when its cleanup port throws synchronously", async () => {
    const target = await fixture({
      settlement: () => {
        throw new Error("Settlement port unavailable.");
      },
    });
    const native = vi.fn(async () => {});
    target.service.trackSettlement("mission", native);
    await target.service.commit("mission");
    await target.service.runOnce();
    expect(native).toHaveBeenCalledOnce();
    expect((await target.service.read("mission"))?.steps.settlement.done).toBe(false);
  });
  it("rejects recovery of a storage journal belonging to another owner type", async () => {
    const target = await fixture();
    const journal = join(target.paths.deletionJournalRoot(), `${target.record.deletionId}.json`);
    await moveOwnedStorageToTrash({
      paths: target.paths,
      deletionId: target.record.deletionId,
      owner: { type: "expert-session", id: "mission" },
      sources: [],
    });
    const before = await readFile(journal, "utf8");
    await target.service.runOnce();
    expect((await target.service.read("mission"))?.phase).toBe("prepared");
    expect(await readFile(journal, "utf8")).toBe(before);
    for (const port of Object.values(target.ports)) expect(port).not.toHaveBeenCalled();
    expect(target.service.inspect().state).toBe("degraded");
  });
  it("observes independent cleanup failures even when orphan inventory is invalid", async () => {
    const target = await fixture({
      settlement: async () => {
        throw new Error("Settlement port unavailable.");
      },
    });
    const native = vi.fn(async () => {
      throw new Error("Native stop unavailable.");
    });
    await target.service.updateOwners("mission", [], { sessionIds: "invalid" });
    target.service.trackSettlement("mission", native);
    await target.service.commit("mission");
    await target.service.runOnce();
    expect(native).toHaveBeenCalledOnce();
    expect((await target.service.read("mission"))?.steps.settlement).toMatchObject({
      done: false,
      attempts: 1,
    });
  });
  it("does not rewrite progress while a failed step waits for retry", async () => {
    const target = await fixture({
      usage: async () => {
        throw new Error("ledger unavailable");
      },
    });
    await target.service.commit("mission");
    await target.service.runOnce();
    const path = target.paths.missionDeletion("mission");
    const before = await stat(path);
    await target.service.runOnce();
    const after = await stat(path);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(target.ports.memory).toHaveBeenCalledOnce();
  });
  it("continues committed cleanup after trash and its journal expire", async () => {
    const target = await fixture({
      usage: async () => {
        throw new MissionDeletionSourceExpiredError();
      },
    });
    await target.service.commit("mission");
    await rm(join(target.paths.deletionJournalRoot(), `${target.record.deletionId}.json`));
    await rm(join(target.paths.trashRoot(), target.record.deletionId), {
      recursive: true,
      force: true,
    });
    const recovered = target.makeService();
    await recovered.runOnce();
    const record = await recovered.read("mission");
    expect(record?.phase).toBe("completed");
    expect(record?.steps.usage.errorCode).toBe("MISSION_DELETE_USAGE_SOURCE_EXPIRED");
    for (const step of ["memory", "drafts", "claims", "settlement"] as const)
      expect(target.ports[step]).toHaveBeenCalledOnce();
  });
  it("compacts progress after a crash following the last completed step", async () => {
    const target = await fixture();
    await target.service.commit("mission");
    const record = (await target.service.read("mission"))!;
    for (const step of Object.values(record.steps)) step.done = true;
    await writeFile(target.paths.missionDeletion("mission"), JSON.stringify(record));
    await target.makeService().runOnce();
    expect((await target.service.read("mission"))?.phase).toBe("completed");
    for (const port of Object.values(target.ports)) expect(port).not.toHaveBeenCalled();
  });
  it("reruns Runtime settlement cleanup after a recoverable failure", async () => {
    const target = await fixture();
    const cleanup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("Runtime cleanup failed"));
    target.service.trackSettlement("mission", cleanup);
    await target.service.commit("mission");
    await target.service.runOnce();
    const record = (await target.service.read("mission"))!;
    expect(record.steps.settlement.done).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    record.steps.settlement.nextAt = 0;
    await writeFile(target.paths.missionDeletion("mission"), JSON.stringify(record));
    await target.service.runOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect((await target.service.read("mission"))?.phase).toBe("completed");
  });
  it("stops after ten shared retries and preserves the limit after restart", async () => {
    const usage = vi.fn(async () => {
      throw new Error("permanent failure");
    });
    const target = await fixture({ usage });
    await target.service.commit("mission");
    await target.service.runOnce();
    let worker = target.makeService();
    for (let index = 0; index < MISSION_DELETION_MAX_RETRIES; index++) {
      const record = (await worker.read("mission"))!;
      for (const step of Object.values(record.steps)) step.nextAt = 0;
      await writeFile(target.paths.missionDeletion("mission"), JSON.stringify(record));
      worker = target.makeService();
      await worker.runOnce();
    }
    expect(usage).toHaveBeenCalledTimes(11);
    expect(await worker.read("mission")).toMatchObject({
      phase: "committed",
      retryAttempts: 10,
      steps: { usage: { runs: 11, attempts: 11, done: false } },
    });
    const before = await readFile(target.paths.missionDeletion("mission"), "utf8");
    await Promise.all([worker.runOnce(), target.makeService().runOnce()]);
    expect(usage).toHaveBeenCalledTimes(11);
    expect(await readFile(target.paths.missionDeletion("mission"), "utf8")).toBe(before);
    expect(worker.inspect()).toMatchObject({
      state: "degraded",
      errorCode: "mission.delete_cleanup_retry_exhausted",
    });
    // Exhaustion belongs to this Mission, not to the shared worker.
    await worker.prepare({ missionId: "another", executionIds: [], payload: {} });
    await worker.commit("another");
    await worker.runOnce();
    expect(usage).toHaveBeenCalledTimes(12);
    expect((await worker.read("another"))?.retryAttempts).toBe(0);
  });
  it("shares the ten-retry budget across steps and concurrent workers", async () => {
    const fail = () =>
      vi.fn(async () => {
        throw new Error("unavailable");
      });
    const target = await fixture({
      usage: fail(),
      memory: fail(),
      drafts: fail(),
      claims: fail(),
      settlement: fail(),
    });
    await target.service.commit("mission");
    await target.service.runOnce();
    for (let round = 0; round < 12; round++) {
      const record = (await target.service.read("mission"))!;
      for (const step of Object.values(record.steps)) step.nextAt = 0;
      await writeFile(target.paths.missionDeletion("mission"), JSON.stringify(record));
      await Promise.all([target.service.runOnce(), target.makeService().runOnce()]);
    }
    const calls = Object.values(target.ports).reduce(
      (sum, port) => sum + vi.mocked(port).mock.calls.length,
      0,
    );
    expect(calls).toBe(5 + MISSION_DELETION_MAX_RETRIES);
    expect((await target.service.read("mission"))?.retryAttempts).toBe(10);
  });
  it("also stops permanently failing prepared recovery after ten attempts", async () => {
    const target = await fixture();
    await mkdir(target.paths.deletionJournalRoot(), { recursive: true });
    await writeFile(
      join(target.paths.deletionJournalRoot(), `${target.record.deletionId}.json`),
      "{}",
    );
    for (let index = 0; index < 12; index++) await target.makeService().runOnce();
    expect((await target.service.read("mission"))?.retryAttempts).toBe(10);
    for (const port of Object.values(target.ports)) expect(port).not.toHaveBeenCalled();
    const worker = target.makeService();
    await worker.runOnce();
    expect(worker.inspect().errorCode).toBe("mission.delete_cleanup_retry_exhausted");
  });
  it.each([
    ["retried", 1],
    ["exhausted", 10],
  ] as const)(
    "migrates the real v1 %s writer without resetting its budget",
    async (name, retries) => {
      const target = await fixture();
      const source = await readFile(
        new URL(`./fixtures/mission-deletion-v1-${name}.json`, import.meta.url),
        "utf8",
      );
      await writeFile(target.paths.missionDeletion("mission"), source);
      const worker = target.makeService();
      expect(await worker.read("mission")).toMatchObject({
        schemaVersion: "pragma.mission-deletion/v2",
        retryAttempts: retries,
      });
      expect(
        await readFile(
          join(
            target.paths.archivesRoot(),
            "storage-migrations",
            "mission-deletion-v2",
            encodePragmaPathSegment("mission"),
            "pending.json",
          ),
          "utf8",
        ),
      ).toBe(source);
      if (name === "exhausted") {
        await worker.runOnce();
        for (const port of Object.values(target.ports)) expect(port).not.toHaveBeenCalled();
      }
    },
  );
  it("replays an interrupted v1 upgrade without losing the retry budget", async () => {
    const target = await fixture();
    const source = await readFile(
      new URL("./fixtures/mission-deletion-v1-retried.json", import.meta.url),
      "utf8",
    );
    const path = target.paths.missionDeletion("mission");
    await writeFile(path, source);
    const backup = join(
      target.paths.archivesRoot(),
      "storage-migrations",
      "mission-deletion-v2",
      encodePragmaPathSegment("mission"),
      "pending.json",
    );
    await mkdir(dirname(backup), { recursive: true });
    await writeFile(backup, source);
    const upgraded = missionDeletionMigrationChain.upgrade(JSON.parse(source)).value;
    await writeFile(
      `${path}.migration`,
      JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.mission-deletion", id: "mission" },
        fromVersion: 1,
        toVersion: 2,
        documents: { [basename(path)]: upgraded },
      }),
    );
    expect(await target.makeService().read("mission")).toMatchObject({
      schemaVersion: "pragma.mission-deletion/v2",
      retryAttempts: 1,
    });
    await expect(readFile(`${path}.migration`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(backup, "utf8")).toBe(source);
  });
  it("does not rewrite a current deletion record on read", async () => {
    const target = await fixture();
    const path = target.paths.missionDeletion("mission");
    const before = await readFile(path, "utf8");
    await target.service.read("mission");
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("rejects a future record and leaves it available for diagnosis", async () => {
    const target = await fixture();
    const path = target.paths.missionDeletion("mission");
    await writeFile(
      path,
      JSON.stringify({ ...target.record, schemaVersion: "pragma.mission-deletion/v999" }),
    );
    await expect(target.service.read("mission")).rejects.toThrow();
    await target.service.runOnce();
    expect(target.service.inspect().state).toBe("degraded");
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(
      "pragma.mission-deletion/v999",
    );
    for (const port of Object.values(target.ports)) expect(port).not.toHaveBeenCalled();
  });
  it("serializes two process-equivalent workers with per-step file locks", async () => {
    const target = await fixture();
    await target.service.commit("mission");
    await Promise.all([target.service.runOnce(), target.makeService().runOnce()]);
    for (const port of Object.values(target.ports)) expect(port).toHaveBeenCalledOnce();
  });
});
