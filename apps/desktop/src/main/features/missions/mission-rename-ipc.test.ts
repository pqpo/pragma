import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RuntimeResolver } from "@pragma/core";
import {
  createLocalHostMissionApplication,
  createLocalHostMissionController,
  createMissionStore,
  createSqliteExecutionStore,
  type LocalHostMissionExecutionResourcePorts,
} from "@pragma/local-host";
import { installMissionHandlers } from "./mission-ipc.ts";

const handlers = vi.hoisted(
  () => new Map<string, (_event: unknown, input: unknown) => Promise<unknown>>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (_event: unknown, input: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
  },
  protocol: { handle: vi.fn() },
  net: {},
  dialog: {},
}));

it("persists renames through the shared application and broadcasts the updated Mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-rename-ipc-"));
  const missionsPath = join(root, "missions");
  const missions = createMissionStore({ missionsPath });
  const mission = await missions.create({
    workspace: { path: root, basename: "workspace" },
    goal: "Original task input",
    project: { id: "studio", revision: 1 },
    executor: { kind: "expert", ref: "expert:0000000000pragma", name: "Expert" },
  });
  const lifecycle = createLocalHostMissionController({
    missionsPath,
    missionPath: missions.storagePath,
  });
  const executions = createSqliteExecutionStore({ pragmaHome: root });
  const unavailable = vi.fn(async () => {
    throw new Error("Rename must not access a runtime");
  });
  const runtimes: RuntimeResolver = {
    getDefaultRuntimeId: unavailable,
    bind: unavailable,
    resolve: unavailable,
  };
  const resources: LocalHostMissionExecutionResourcePorts = {
    createCompileService: () =>
      ({}) as ReturnType<LocalHostMissionExecutionResourcePorts["createCompileService"]>,
    createExecutionContextResources: unavailable,
    readProjectResources: unavailable,
    readIdentityMigrations: unavailable,
    withContextMountLocks: async (_ids, operation) => await operation(),
    assertContextMountAvailable: unavailable,
    releaseMissionClaim: unavailable,
  };
  const application = createLocalHostMissionApplication({
    execution: {
      missions,
      pragmaHome: root,
      executionStore: executions,
      runtimes,
      resourcePorts: resources,
    },
    lifecycle,
    client: { surface: "desktop", version: "test", instanceId: crypto.randomUUID() },
    resolveExecutor: async () => {
      throw new Error("Rename must not compile an executor");
    },
  });
  const send = vi.fn();
  try {
    // Only the Electron/window and unrelated Host resources are substituted.
    installMissionHandlers({
      missions,
      application,
      localHost: { getMission: (id: string) => missions.get(id) },
      getAutomationMissionSources: async () => new Map(),
      getWindow: () => ({ webContents: { send } }),
      temporaryRoot: join(root, "tmp"),
    } as unknown as Parameters<typeof installMissionHandlers>[0]);
    const countReferences = handlers.get("missions:context-store:reference-count")!;
    const storeId = crypto.randomUUID();
    await expect(countReferences({}, { storeId })).resolves.toBe(0);
    await missions.updateContextMounts(mission.id, [{ kind: "context-store", storeId }]);
    await missions.create({
      workspace: mission.workspace,
      goal: "Another linked Mission",
      project: mission.project,
      executor: mission.executor,
      contextMounts: [{ kind: "context-store", storeId }],
    });
    await expect(countReferences({}, { storeId })).resolves.toBe(2);
    await missions.updateContextMounts(mission.id, []);
    await expect(countReferences({}, { storeId })).resolves.toBe(1);
    await expect(countReferences({}, { storeId: "invalid" })).rejects.toThrow();
    const rename = handlers.get("missions:rename")!;
    await expect(
      rename({}, { id: mission.id, title: "  Manually renamed  " }),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: mission.id, title: "Manually renamed", goal: mission.goal },
    });
    expect((await createMissionStore({ missionsPath }).get(mission.id)).title).toBe(
      "Manually renamed",
    );
    expect(send).toHaveBeenCalledWith(
      "missions:updated",
      expect.objectContaining({
        kind: "upsert",
        mission: expect.objectContaining({ id: mission.id, title: "Manually renamed" }),
      }),
    );
    expect(unavailable).not.toHaveBeenCalled();
    send.mockClear();
    await expect(rename({}, { id: mission.id, title: "x".repeat(49) })).resolves.toMatchObject({
      ok: false,
    });
    expect(send).not.toHaveBeenCalled();
    expect((await missions.get(mission.id)).title).toBe("Manually renamed");
  } finally {
    await application.dispose();
    await executions.close();
    await rm(root, { recursive: true, force: true });
  }
});
