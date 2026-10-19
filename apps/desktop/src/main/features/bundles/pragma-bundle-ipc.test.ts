import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PragmaPaths } from "@pragma/core";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import {
  createContextStoreStore,
  createPragmaBundleService,
  createPragmaProjectStore,
  createWorkflowLayoutStore,
  desktopContextBindingRef,
  type CapabilityStore,
  type PluginStore,
} from "@pragma/local-host/deployment";
import type { PragmaBundleImportInspection } from "@pragma/local-host/deployment-contracts";
import { installPragmaBundleHandlers } from "./pragma-bundle-ipc.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  save: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(name, handler),
  },
  dialog: { showSaveDialog: electron.save, showOpenDialog: vi.fn() },
}));
const roots: string[] = [];
afterEach(async () => {
  electron.handlers.clear();
  electron.save.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function host(root: string) {
  const paths = new PragmaPaths({ pragmaHome: root });
  const project = createPragmaProjectStore({
    projectsPath: paths.projectsRoot(),
    objectsPath: paths.contentObjectsRoot(),
    projectViewsPath: paths.projectViewsCacheRoot(),
  });
  const contextStores = createContextStoreStore({ storesPath: paths.contextStoresRoot() });
  const service = createPragmaBundleService({
    paths,
    project,
    contextStores,
    capabilities: { list: async () => [] } as unknown as CapabilityStore,
    plugins: { list: async () => [] } as unknown as PluginStore,
    layouts: createWorkflowLayoutStore({ projectsPath: paths.projectsRoot() }),
    getRuntimes: async () => [],
  });
  return { project, contextStores, service };
}
describe("Desktop Bundle production IPC wiring", () => {
  it("exports and installs a real archive through the shared persistence service with safe retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-deployment-"));
    roots.push(root);
    const source = await host(join(root, "source"));
    const store = await source.contextStores.createFromSnapshot({
      name: "IPC handbook",
      description: "Shared deployment wiring.",
      author: "user",
      summary: "Create source.",
      files: [
        {
          id: "guide.md",
          content: "# Verified IPC\\n",
          metadata: { description: "Guide", trigger: "always_on", priority: "high" },
        },
      ],
    });
    const snapshot = await source.project.publish({
      expectedRevision: 0,
      resources: [
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "ContextStore",
          metadata: {
            id: "kqh4nx7rx26mb3e7",
            name: "IPC handbook",
            description: "Shared deployment wiring.",
            tags: [],
          },
          spec: {
            adapter: "pragma.context.host@v1",
            binding: desktopContextBindingRef(store.id),
            config: { key: store.id },
          },
        },
      ],
    });
    const path = join(root, "wiring.pragma");
    electron.save.mockResolvedValue({ canceled: false, filePath: path });
    installPragmaBundleHandlers(source.service, () => null);
    const exported = await electron.handlers.get("pragma-bundles:export")!(
      {},
      {
        rootRef: "context-store:kqh4nx7rx26mb3e7",
        projectRevision: snapshot.revision,
        modules: { capabilities: false, plugins: false, knowledgeBases: true, flowLayouts: false },
      },
    );
    expect(exported).toMatchObject({ ok: true, value: { path } });
    const target = await host(join(root, "target"));
    installPragmaBundleHandlers(target.service, () => null);
    const inspection = (await electron.handlers.get("pragma-bundles:inspect")!(
      {},
      { sourcePath: path },
    )) as PragmaBundleImportInspection;
    const request = {
      requestId: randomUUID(),
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: inspection.bundleFingerprint,
      expectedProjectFingerprint: inspection.projectFingerprint,
      expectedProjectRevision: inspection.projectRevision,
    };
    const installed = await electron.handlers.get("pragma-bundles:import")!({}, request);
    expect(installed).toMatchObject({
      ok: true,
      value: { status: "ready", schemaVersion: "pragma.bundle-installation/v9" },
    });
    expect(await electron.handlers.get("pragma-bundles:import")!({}, request)).toEqual(installed);
    expect(await target.service.listInstallations()).toHaveLength(1);
    expect(await target.contextStores.list()).toHaveLength(1);
  });
});
