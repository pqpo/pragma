import { mkdtemp, readFile, rm, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PragmaPaths,
  createPragmaLogger,
  moveOwnedStorageToTrash,
  createRuntimeSessionRecord,
  readRuntimeSessionRecord,
} from "@pragma/core";
import {
  createMissionDeletionService,
  MissionDeletionSourceExpiredError,
  type MissionDeletionPorts,
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
  const makeService = () =>
    createMissionDeletionService({
      paths,
      ports,
      logger: createPragmaLogger(undefined, { component: "deletion-test" }),
      stepTimeoutMs: 20,
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
    payload: { title: "delete" },
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
    await target.service.commit("mission");
    await target.service.runOnce();
    expect((await target.service.read("mission"))?.phase).toBe("completed");
    await target.makeService().runOnce();
    for (const port of Object.values(target.ports)) expect(port).toHaveBeenCalledOnce();
  });
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
