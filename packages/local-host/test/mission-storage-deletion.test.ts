import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createPragmaLogger,
  moveOwnedStorageToTrash,
  PragmaPaths,
  readRuntimeSessionsForOwners,
} from "@pragma/core";
import { afterEach, expect, it } from "vitest";
import { createMissionControllerStore } from "../src/missions/controller/mission-controller-store.ts";
import { withMissionControllerDeletionBarrier } from "../src/missions/controller/storage-locks.ts";
import {
  createMissionDeletionService,
  isMissionDeletionCommitted,
} from "../src/missions/deletion.ts";
import { createMissionStore } from "../src/missions/repository/mission-store.ts";

const roots: string[] = [];
const missionId = "4b4f2993-4f39-4915-adc4-a052163d4e28";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  onJournalPhase?: Parameters<typeof createMissionControllerStore>[0]["onJournalPhase"],
) {
  const home = await mkdtemp(join(tmpdir(), "pragma-mission-delete-write-"));
  roots.push(home);
  const paths = new PragmaPaths({ pragmaHome: home });
  const repository = createMissionStore({ missionsPath: paths.missionsRoot() });
  const controllerOptions = {
    missionsPath: paths.missionsRoot(),
    missionPath: repository.storagePath,
    isDeletionCommitted: async (id: string) => await isMissionDeletionCommitted(paths, id),
  };
  const controller = createMissionControllerStore({ ...controllerOptions, onJournalPhase });
  const otherController = createMissionControllerStore(controllerOptions);
  const guard = await controller.claim({ missionId, claimId: missionId, leaseMs: 60_000 });
  const deletion = createMissionDeletionService({
    paths,
    logger: createPragmaLogger(undefined, { component: "test" }),
    ports: {
      usage: async () => {},
      memory: async () => {},
      drafts: async () => {},
      claims: async () => {},
      settlement: async () => {},
    },
  });
  const remove = async (beforeMove: () => void = () => {}) => {
    const record = await deletion.prepare({ missionId, executionIds: [], payload: {} });
    await withMissionControllerDeletionBarrier(
      paths.missionsRoot(),
      missionId,
      async () =>
        await repository.withDeletionBarrier!(missionId, async () => {
          beforeMove();
          await moveOwnedStorageToTrash({
            paths,
            deletionId: record.deletionId,
            owner: { type: "mission", id: missionId },
            sources: [{ label: "mission", path: repository.storagePath!(missionId) }],
            onCommitted: async () => await deletion.commit(missionId),
          });
        }),
    );
    return join(paths.trashRoot(), record.deletionId, "mission");
  };
  return { paths, repository, controller, otherController, guard, deletion, remove };
}

it("drains an in-flight semantic journal before moving storage and fences late claims and writes", async () => {
  let prepared!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const target = await fixture();
  let applied = false;
  const write = target.controller.coordinateSemanticWrite({
    missionId,
    guard: target.guard,
    operation: { name: "mission.options.update", input: {} },
    eventType: "mission.options.updated",
    eventData: {},
    apply: async () => {
      prepared();
      await gate;
      applied = true;
    },
  });
  await entered;
  const deletion = target.remove(() => {
    expect(applied).toBe(true);
  });
  // Aggregate events remain available while deletion waits for the semantic transaction.
  await target.otherController.write({
    missionId,
    guard: target.guard,
    operation: async ({ appendEvent }) => {
      await appendEvent("runtime.event", {});
    },
  });
  resume();
  await write;
  const trash = await deletion;
  expect(await readdir(join(trash, "local-host"))).not.toContain(
    ".semantic-write-transaction.json",
  );
  for (const controller of [target.controller, target.otherController]) {
    await expect(
      controller.claim({ missionId, claimId: missionId, leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
    await expect(
      controller.renew({ missionId, guard: target.guard, leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
    await expect(
      controller.coordinateSemanticWrite({
        missionId,
        guard: target.guard,
        operation: { name: "mission.options.update", input: {} },
        eventType: "mission.options.updated",
        eventData: {},
        apply: async () => {},
      }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  }
  await expect(stat(target.repository.storagePath!(missionId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves a failed mutation journal in trash and fences a fresh controller after restart", async () => {
  const target = await fixture();
  await expect(
    target.controller.coordinateSemanticWrite({
      missionId,
      guard: target.guard,
      operation: { name: "mission.options.update", input: {} },
      eventType: "mission.options.updated",
      eventData: {},
      apply: async () => {
        throw new Error("crash after mutation");
      },
    }),
  ).rejects.toThrow("pending durable replay");
  const journal = ".semantic-write-transaction.json";
  const original = await readFile(
    join(target.repository.storagePath!(missionId), "local-host", journal),
    "utf8",
  );
  const trash = await target.remove();
  expect(await readFile(join(trash, "local-host", journal), "utf8")).toBe(original);
  await target.deletion.runOnce();
  expect((await target.deletion.read(missionId))?.phase).toBe("completed");
  const restarted = createMissionControllerStore({
    missionsPath: target.paths.missionsRoot(),
    missionPath: target.repository.storagePath,
    isDeletionCommitted: async (id) => await isMissionDeletionCommitted(target.paths, id),
  });
  await expect(
    restarted.claim({ missionId, claimId: missionId, leaseMs: 60_000 }),
  ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
  await expect(stat(target.repository.storagePath!(missionId))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["file_move", "onCommitted"])(
  "fences a moved owner before Host commit after failure at %s",
  async (failureAt) => {
    const target = await fixture();
    const record = await target.deletion.prepare({
      missionId,
      executionIds: [],
      payload: {},
      missionPath: target.repository.storagePath!(missionId),
    });
    expect(await isMissionDeletionCommitted(target.paths, missionId)).toBe(false);
    await expect(
      target.otherController.claim({ missionId, claimId: missionId, leaseMs: 60_000 }),
    ).resolves.toMatchObject({
      claimId: target.guard.claimId,
      fencingToken: target.guard.fencingToken,
    });
    await expect(
      target.controller.assertWriteGuard({ missionId, guard: target.guard }),
    ).resolves.toBeUndefined();
    await expect(
      withMissionControllerDeletionBarrier(target.paths.missionsRoot(), missionId, async () => {
        await moveOwnedStorageToTrash({
          paths: target.paths,
          deletionId: record.deletionId,
          owner: { type: "mission", id: missionId },
          sources: [{ label: "mission", path: target.repository.storagePath!(missionId) }],
          onPhase: (phase) => {
            if (failureAt === phase) throw new Error("process exited after move");
          },
          onCommitted: async () => {
            throw new Error("Host commit callback failed");
          },
        });
      }),
    ).rejects.toThrow();
    expect((await target.deletion.read(missionId))?.phase).toBe("prepared");
    const restarted = createMissionControllerStore({
      missionsPath: target.paths.missionsRoot(),
      missionPath: target.repository.storagePath,
      isDeletionCommitted: async (id) => await isMissionDeletionCommitted(target.paths, id),
    });
    expect(await isMissionDeletionCommitted(target.paths, missionId)).toBe(true);
    await expect(
      restarted.claim({ missionId, claimId: missionId, leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
    await expect(
      restarted.write({ missionId, guard: target.guard, operation: async () => {} }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
    await expect(stat(target.repository.storagePath!(missionId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await target.deletion.read(missionId))?.phase).toBe("prepared");
    await target.deletion.runOnce();
    expect((await target.deletion.read(missionId))?.phase).toBe("completed");
  },
);

it("serializes deletion in a separate process with the complete semantic transaction", async () => {
  const target = await fixture();
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const write = target.controller.coordinateSemanticWrite({
    missionId,
    guard: target.guard,
    operation: { name: "mission.options.update", input: {} },
    eventType: "mission.options.updated",
    eventData: {},
    apply: async () => {
      entered();
      await gate;
    },
  });
  await started;
  await target.deletion.prepare({ missionId, executionIds: [], payload: {} });
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/mission-deletion-barrier.mjs", import.meta.url)),
      target.paths.root,
      missionId,
      target.repository.storagePath!(missionId),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Deletion process failed: ${stderr}`)),
    );
  });
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("message", () => resolve());
      }),
      exited.then(() => {
        throw new Error("Deletion process exited before acquiring its barrier");
      }),
    ]);
    await target.otherController.write({
      missionId,
      guard: target.guard,
      operation: async ({ appendEvent }) => {
        await appendEvent("runtime.event", {});
      },
    });
    resume();
    await Promise.all([write, exited]);
    expect(await isMissionDeletionCommitted(target.paths, missionId)).toBe(true);
    await expect(
      target.otherController.claim({ missionId, claimId: missionId, leaseMs: 60_000 }),
    ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
    await expect(stat(target.repository.storagePath!(missionId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    resume();
    child.kill();
    await Promise.allSettled([write, exited]);
  }
});

// Exercise both real recovery entrances, after the deletion journal/catalog prepare
// but before the owner rename. The trash obstruction creates that crash window.
it.each([
  ["background", "aggregate"],
  ["background", "semantic"],
  ["catalog", "aggregate"],
  ["catalog", "semantic"],
] as const)(
  "%s recovery drains an already validated %s write before moving the owner",
  async (entrance, writer) => {
    const target = await fixture();
    const ownerPath = target.repository.storagePath!(missionId);
    const record = await target.deletion.prepare({
      missionId,
      executionIds: [],
      payload: {},
      missionPath: ownerPath,
    });
    const trash = join(target.paths.trashRoot(), record.deletionId);
    await mkdir(trash, { recursive: true });
    await writeFile(join(trash, "mission"), "block owner rename");
    await expect(
      withMissionControllerDeletionBarrier(target.paths.missionsRoot(), missionId, async () => {
        await moveOwnedStorageToTrash({
          paths: target.paths,
          deletionId: record.deletionId,
          owner: { type: "mission", id: missionId },
          sources: [{ label: "mission", path: ownerPath }],
          runtimeSessionOwnerIds: [],
          onCommitted: async () => await target.deletion.commit(missionId),
        });
      }),
    ).rejects.toThrow();
    await rm(join(trash, "mission"));
    expect((await target.deletion.read(missionId))?.phase).toBe("prepared");
    expect(
      JSON.parse(
        await readFile(
          join(target.paths.deletionJournalRoot(), `${record.deletionId}.json`),
          "utf8",
        ),
      ).status,
    ).toBe("moving");
    expect(await isMissionDeletionCommitted(target.paths, missionId)).toBe(false);

    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const write =
      writer === "aggregate"
        ? target.controller.write({
            missionId,
            guard: target.guard,
            operation: async ({ appendEvent }) => {
              entered();
              await gate;
              await appendEvent("recovery.in-flight-write", {});
            },
          })
        : target.controller.coordinateSemanticWrite({
            missionId,
            guard: target.guard,
            operation: { name: "mission.options.update", input: {} },
            eventType: "recovery.in-flight-write",
            eventData: {},
            apply: async () => {
              entered();
              await gate;
            },
          });
    await started;
    const recovery =
      entrance === "background"
        ? target.deletion.runOnce()
        : readRuntimeSessionsForOwners(target.paths, [missionId]);
    try {
      expect(
        await Promise.race([
          recovery.then(() => "finished"),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("waiting"), 100);
          }),
        ]),
      ).toBe("waiting");
      await expect(stat(ownerPath)).resolves.toBeDefined();
      // Recovery must wait for owner locks BEFORE taking the catalog lock.
      await expect(
        stat(join(target.paths.runtimeSessionsRoot(), "catalog.sqlite.deletion.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      if (writer === "semantic") {
        await target.otherController.write({
          missionId,
          guard: target.guard,
          operation: async ({ appendEvent }) => {
            await appendEvent("runtime.event", {});
          },
        });
      }
      resume();
      await Promise.all([write, recovery]);
      const events = await readFile(join(trash, "mission", "local-host", "events.jsonl"), "utf8");
      expect(events).toContain("recovery.in-flight-write");
      await expect(
        stat(join(trash, "mission", "local-host", ".semantic-write-transaction.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await isMissionDeletionCommitted(target.paths, missionId)).toBe(true);
      await expect(
        target.otherController.write({ missionId, guard: target.guard, operation: async () => {} }),
      ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
      await expect(
        target.otherController.claim({ missionId, claimId: missionId, leaseMs: 60_000 }),
      ).rejects.toMatchObject({ code: "MISSION_NOT_FOUND" });
      // Catalog recovery also remains replayable by the Host finalizer.
      await target.deletion.runOnce();
      expect((await target.deletion.read(missionId))?.phase).toBe("completed");
      await expect(stat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      resume();
      await Promise.allSettled([write, recovery]);
    }
  },
);
