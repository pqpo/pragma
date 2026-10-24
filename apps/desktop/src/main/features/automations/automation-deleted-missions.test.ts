import { access, mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PragmaPaths, createPragmaLogger, createNoopLoggerProvider } from "@pragma/core";
import { createMissionStore, createMissionDeletionService } from "@pragma/local-host";
import { createPragmaProjectStore } from "@pragma/local-host/deployment";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaAutomationResourceSchema,
} from "@pragma/interpreter/ast";
import { createAutomationService } from "./automation-service.ts";
import { createAutomationStore, createAutomationBinding } from "./automation-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("preserves deletion fences while backfilling, rotating, resetting and deleting an Automation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-automation-deleted-mission-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  const project = createPragmaProjectStore({
    projectsPath: join(root, "projects"),
    reservedResourceRefs: new Set(["expert:t9ne4d8njvvxv2ea"]),
  });
  const store = createAutomationStore(paths, "studio");
  const noop = async () => {};
  const deletion = createMissionDeletionService({
    paths,
    logger: createPragmaLogger(createNoopLoggerProvider(), { component: "test" }),
    ports: { usage: noop, memory: noop, drafts: noop, claims: noop, settlement: noop },
  });
  const missions = createMissionStore({
    missionsPath: join(root, "missions"),
    isDeletionFenced: async (id) => (await deletion.read(id)) !== undefined,
  });
  const service = createAutomationService({
    paths,
    project,
    store,
    missions,
    creator: {} as Parameters<typeof createAutomationService>[0]["creator"],
    application: {} as Parameters<typeof createAutomationService>[0]["application"],
  });
  const resource = PragmaAutomationResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Automation",
    metadata: {
      id: "m9a8n9nxvvyb4j01",
      name: "Legacy review",
      description: "Migrates its existing Mission source",
      tags: [],
    },
    spec: {
      adapter: "pragma.automation.schedule@v1",
      binding: "binding:desktop-automation",
      config: {
        trigger: { kind: "calendar", frequency: "daily", time: "09:00", timezone: "UTC" },
      },
      enabled: true,
      route: {
        executor: { ref: "expert:t9ne4d8njvvxv2ea" },
        input: { kind: "prompt", value: "Review the release." },
      },
      interaction: { mode: "new-mission" },
      delivery: { adapter: "pragma.automation.delivery.local@v1" },
    },
  });
  const ref = "automation:m9a8n9nxvvyb4j01";
  const save = async (contextMounts: { kind: "context-store"; storeId: string }[] = []) =>
    await service.save({
      expectedProjectRevision: (await project.get()).revision,
      resource,
      binding: { workspace: root, contextMounts },
    });
  const initial = await save();
  const base = {
    workspace: { path: root, basename: "workspace" },
    goal: "Legacy Automation run",
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert" as const, ref: "expert:t9ne4d8njvvxv2ea", name: "Expert" },
  };
  const deleted = await missions.create(base);
  const surviving = await missions.create(base);
  const missingId = crypto.randomUUID();
  const completedId = crypto.randomUUID();
  await deletion.prepare({ missionId: completedId, executionIds: [], payload: {} });
  await deletion.commit(completedId);
  await deletion.runOnce();
  expect((await deletion.read(completedId))!.phase).toBe("completed");
  await deletion.prepare({ missionId: deleted.id, executionIds: [], payload: {} });
  const timestamp = new Date().toISOString();
  await store.updateState(ref, initial.binding!.generation, (state) => ({
    ...state,
    missionId: deleted.id,
    runs: [deleted.id, surviving.id, missingId, completedId].map((missionId) => ({
      eventId: missionId,
      missionId,
      status: "dispatched" as const,
      scheduledFor: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
  }));
  await expect(service.listMissionSources()).resolves.toEqual(
    new Map([deleted.id, surviving.id, missingId, completedId].map((id) => [id, ref])),
  );
  expect((await missions.get(surviving.id)).origin).toEqual({
    type: "automation",
    automationRef: ref,
  });
  expect((await missions.get(deleted.id)).origin).toEqual({ type: "user" });
  await expect(missions.backfillAutomationOrigin(deleted.id, ref)).rejects.toThrow(
    "MISSION_DELETION_PENDING",
  );
  await expect(missions.backfillAutomationOrigin(completedId, ref)).rejects.toThrow(
    "MISSION_DELETION_PENDING",
  );
  // Restart against the same durable histories and completed deletion record.
  const completedRecord = await deletion.read(completedId);
  const reopened = createAutomationService({
    paths,
    project,
    store: createAutomationStore(paths, "studio"),
    missions: createMissionStore({
      missionsPath: join(root, "missions"),
      isDeletionFenced: async (id) => (await deletion.read(id)) !== undefined,
    }),
    creator: {} as Parameters<typeof createAutomationService>[0]["creator"],
    application: {} as Parameters<typeof createAutomationService>[0]["application"],
  });
  try {
    await expect(reopened.start()).resolves.toBeUndefined();
    await expect(reopened.listMissionSources()).resolves.toEqual(
      new Map([deleted.id, surviving.id, missingId, completedId].map((id) => [id, ref])),
    );
  } finally {
    reopened.stop();
  }
  for (const id of [missingId, completedId]) {
    await expect(access(missions.storagePath!(id))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await deletion.read(completedId)).toEqual(completedRecord);
  // Unexpected write failures must still stop destructive generation retirement.
  const backfill = vi.spyOn(missions, "backfillAutomationOrigin");
  backfill.mockRejectedValue(new Error("disk write failed"));
  await expect(save([{ kind: "context-store", storeId: crypto.randomUUID() }])).rejects.toThrow(
    "disk write failed",
  );
  expect((await store.getBinding(ref))!.generation).toBe(initial.binding!.generation);
  backfill.mockRestore();
  // Saving a knowledge mount rotates the generation and must tolerate stale runs.
  const rotated = await save([{ kind: "context-store", storeId: crypto.randomUUID() }]);
  expect(rotated.binding!.generation).not.toBe(initial.binding!.generation);
  await store.updateState(ref, rotated.binding!.generation, (state) => ({
    ...state,
    missionId: deleted.id,
  }));
  const reset = await service.resetSession(ref);
  expect(reset.binding!.generation).not.toBe(rotated.binding!.generation);
  await store.updateState(ref, reset.binding!.generation, (state) => ({
    ...state,
    missionId: deleted.id,
  }));
  await service.delete({ ref, expectedProjectRevision: (await project.get()).revision });
  expect((await project.get()).resources).toEqual([]);
  expect((await missions.get(surviving.id)).origin.type).toBe("automation");
  await expect(missions.backfillAutomationOrigin(deleted.id, ref)).rejects.toThrow(
    "MISSION_DELETION_PENDING",
  );
}, 30_000);

it("upgrades a real v2 binding once, preserves its original backup and replays the journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-automation-permissions-"));
  roots.push(root);
  const paths = new PragmaPaths({ pragmaHome: root });
  const ref = "automation:0123456789abcdef";
  const path = paths.automationBinding(ref);
  await mkdir(dirname(path), { recursive: true });
  const source = await readFile(
    new URL(
      "../../../../../../packages/local-host/test/fixtures/expert-permissions/automation-binding-v2.json",
      import.meta.url,
    ),
    "utf8",
  );
  await writeFile(path, source);
  const store = createAutomationStore(paths, "studio");
  const upgraded = await store.getBinding(ref);
  expect(upgraded).toMatchObject({
    schemaVersion: "pragma.automation-binding/v3",
    automationRef: ref,
  });
  expect(upgraded).not.toHaveProperty("toolPermissionMode");
  expect(await readFile(`${path}.v2.backup.json`, "utf8")).toBe(source);
  const committed = await readFile(path, "utf8");
  await store.getBinding(ref);
  expect(await readFile(path, "utf8")).toBe(committed);
  await writeFile(path, source);
  await writeFile(
    `${path}.permission-migration.json`,
    JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.automation-binding", id: ref },
      fromVersion: 2,
      toVersion: 3,
      documents: { [relative(paths.root, path)]: upgraded },
    }),
  );
  expect(await createAutomationStore(paths, "studio").getBinding(ref)).toEqual(upgraded);
  expect(await readFile(`${path}.v2.backup.json`, "utf8")).toBe(source);
  const future = JSON.stringify({ ...upgraded, schemaVersion: "pragma.automation-binding/v999" });
  await writeFile(path, future);
  await expect(store.getBinding(ref)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(future);
  await writeFile(path, source);
  await writeFile(
    `${path}.permission-migration.json`,
    JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.automation-binding", id: ref },
      fromVersion: 2,
      toVersion: 3,
      documents: { [relative(paths.root, path)]: upgraded },
    }),
  );
  await store.remove(ref);
  expect(await store.getBinding(ref)).toBeUndefined();
  expect(await readFile(`${path}.v2.backup.json`, "utf8")).toBe(source);
});

it.each(["future", "wrong-owner"])(
  "preserves automation data and journal on %s replay conflicts",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-automation-replay-conflict-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const ref = "automation:0123456789abcdef";
    const store = createAutomationStore(paths, "studio");
    const binding = await store.saveBinding(
      createAutomationBinding({
        automationRef: ref,
        rotateGeneration: true,
        workspace: { path: root, basename: "workspace" },
      }),
    );
    const path = paths.automationBinding(ref);
    const persisted = JSON.stringify({
      ...binding,
      ...(kind === "future" ? { schemaVersion: "pragma.automation-binding/v999" } : {}),
    });
    await writeFile(path, persisted);
    const journal = JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.automation-binding", id: ref },
      fromVersion: 2,
      toVersion: 3,
      documents: {
        [relative(paths.root, path)]: {
          ...binding,
          ...(kind === "wrong-owner" ? { automationRef: "automation:fedcba9876543210" } : {}),
        },
      },
    });
    await writeFile(`${path}.permission-migration.json`, journal);
    await expect(store.getBinding(ref)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(persisted);
    expect(await readFile(`${path}.permission-migration.json`, "utf8")).toBe(journal);
  },
);

it.each(["current", "future", "wrong-owner"])(
  "preserves %s binding data when replaying a stale v1 migration",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-automation-old-journal-"));
    roots.push(root);
    const paths = new PragmaPaths({ pragmaHome: root });
    const ref = "automation:0123456789abcdef";
    const initialStore = createAutomationStore(paths, "studio");
    const binding = await initialStore.saveBinding(
      createAutomationBinding({
        automationRef: ref,
        rotateGeneration: true,
        workspace: { path: root, basename: "workspace" },
      }),
    );
    const path = paths.automationBinding(ref);
    const persisted = JSON.stringify({
      ...binding,
      ...(kind === "future" ? { schemaVersion: "pragma.automation-binding/v999" } : {}),
    });
    await writeFile(path, persisted);
    await rm(join(paths.automationBindingsRoot(), ".v2-migrated"));
    const journalPath = join(paths.storageStateRoot(), "automation-binding-v1-to-v2.json");
    await mkdir(dirname(journalPath), { recursive: true });
    const journal = JSON.stringify({
      schemaVersion: "pragma.state-migration/v1",
      resource: { family: "pragma.automation-binding", id: "studio" },
      fromVersion: 1,
      toVersion: 2,
      documents: {
        [relative(paths.root, path)]: {
          ...binding,
          schemaVersion: "pragma.automation-binding/v2",
          toolPermissionMode: "request-approval",
          ...(kind === "wrong-owner" ? { automationRef: "automation:fedcba9876543210" } : {}),
        },
      },
    });
    await writeFile(journalPath, journal);
    const store = createAutomationStore(paths, "studio");
    await expect(store.getBinding(ref)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(persisted);
    expect(await readFile(journalPath, "utf8")).toBe(journal);
    if (kind === "current") {
      await rm(journalPath);
      expect(await store.getBinding(ref)).toEqual(binding);
    }
  },
);
