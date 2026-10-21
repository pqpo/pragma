import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  isInterruptedBundleInstallation,
  type PragmaBundleImportInspection,
} from "@pragma/local-host/deployment-contracts";
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
async function host(root: string, interruptPublication = false) {
  const paths = new PragmaPaths({ pragmaHome: root });
  const project = createPragmaProjectStore({
    projectsPath: paths.projectsRoot(),
    objectsPath: paths.contentObjectsRoot(),
    projectViewsPath: paths.projectViewsCacheRoot(),
  });
  const contextStores = createContextStoreStore({ storesPath: paths.contextStoresRoot() });
  const service = createPragmaBundleService({
    paths,
    project: new Proxy(project, {
      get(target, property, receiver) {
        if (property !== "publish") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof project.publish>) => {
          if (interruptPublication) {
            interruptPublication = false;
            throw new Error("Interrupted publication.");
          }
          return await target.publish(...args);
        };
      },
    }),
    contextStores,
    capabilities: { list: async () => [] } as unknown as CapabilityStore,
    plugins: { list: async () => [] } as unknown as PluginStore,
    layouts: createWorkflowLayoutStore({ projectsPath: paths.projectsRoot() }),
    getRuntimes: async () => [],
  });
  return { paths, project, contextStores, service };
}
describe("Desktop Bundle production IPC wiring", () => {
  it("safely discards a conflicted transaction and starts a fresh request through IPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-desktop-discard-conflict-"));
    roots.push(root);
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../../../../../packages/local-host/test/fixtures/bundle-installation-v8-interrupted.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { scenarios: { failed: { files: Record<string, string> } } };
    const archive = Object.entries(fixture.scenarios.failed.files).find(([name]) =>
      name.endsWith("source.pragma.bundle"),
    )!;
    const path = join(root, "retry.pragma");
    await writeFile(path, Buffer.from(archive[1], "base64"));
    const target = await host(join(root, "target"), true);
    installPragmaBundleHandlers(target.service, () => null);
    const inspect = async () =>
      (await electron.handlers.get("pragma-bundles:inspect")!(
        {},
        { sourcePath: path },
      )) as PragmaBundleImportInspection;
    const request = (inspection: PragmaBundleImportInspection) => ({
      requestId: randomUUID(),
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: inspection.bundleFingerprint,
      expectedProjectFingerprint: inspection.projectFingerprint,
      expectedProjectRevision: inspection.projectRevision,
    });
    const firstRequest = request(await inspect());
    const failed = (await electron.handlers.get("pragma-bundles:import")!({}, firstRequest)) as {
      ok: true;
      value: { id: string; status: string };
    };
    expect(failed).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(
      await electron.handlers.get("pragma-bundles:inspect")!(
        {},
        { installationId: failed.value.id },
      ),
    ).toMatchObject({
      alreadyInstalledId: failed.value.id,
      sourcePath: target.paths.bundleInstallationArchive(failed.value.id),
    });
    const assetId = (await target.contextStores.list())[0]!.id;
    await target.project.publish({ expectedRevision: 0, resources: [] });
    expect(
      await electron.handlers.get("pragma-bundles:installation:recheck")!(
        {},
        { installationId: failed.value.id },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "installation_target_conflict" },
    });
    expect((await inspect()).alreadyInstalledId).toBe(failed.value.id);
    expect(
      await electron.handlers.get("pragma-bundles:installation:discard")!(
        {},
        { installationId: failed.value.id },
      ),
    ).toMatchObject({ ok: true });
    expect(await target.contextStores.exists(assetId)).toBe(false);
    const fresh = await inspect();
    expect(fresh.alreadyInstalledId).toBeUndefined();
    const nextRequest = request(fresh);
    expect(nextRequest.requestId).not.toBe(firstRequest.requestId);
    expect(await electron.handlers.get("pragma-bundles:import")!({}, nextRequest)).toMatchObject({
      ok: true,
      value: { status: "ready" },
    });
    expect(await target.service.listInstallations()).toHaveLength(1);
    expect(await target.contextStores.list()).toHaveLength(1);
  });

  it.each(["installing", "failed", "missing-journal"] as const)(
    "recovers a real historical v8 %s owner through inspection and IPC",
    async (phase) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-desktop-legacy-recovery-"));
      roots.push(root);
      const fixture = JSON.parse(
        await readFile(
          new URL(
            "../../../../../../packages/local-host/test/fixtures/bundle-installation-v8-interrupted.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as { sourceCommit: string; scenarios: Record<string, { files: Record<string, string> }> };
      expect(fixture.sourceCommit).toBe("e1b6d427e923c3f1b001a471e0aaba0e1e97b7cd");
      for (const [member, base64] of Object.entries(
        fixture.scenarios[phase === "missing-journal" ? "failed" : phase]!.files,
      )) {
        const path = join(root, member);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, Buffer.from(base64, "base64"));
      }
      const target = await host(root);
      if (phase === "missing-journal") {
        // Explicit damage to a genuine historical owner, not a fabricated historical schema.
        const catalog = JSON.parse(
          await readFile(target.paths.bundleInstallationsCatalog(), "utf8"),
        );
        delete catalog.installations[0].knowledgeBaseUpdate;
        await writeFile(target.paths.bundleInstallationsCatalog(), JSON.stringify(catalog));
      }
      installPragmaBundleHandlers(target.service, () => null);
      const [old] = await target.service.listInstallations();
      expect(old).toMatchObject({
        status: phase === "missing-journal" ? "failed" : phase,
        schemaVersion: "pragma.bundle-installation/v9",
      });
      expect(old!.transaction).toBeUndefined();
      expect(isInterruptedBundleInstallation(old!)).toBe(true);
      const archive = join(root, "historical.pragma");
      await writeFile(archive, await readFile(target.paths.bundleInstallationArchive(old!.id)));
      const inspection = (await electron.handlers.get("pragma-bundles:inspect")!(
        {},
        { sourcePath: archive },
      )) as PragmaBundleImportInspection;
      expect(inspection.alreadyInstalledId).toBe(old!.id);
      // A caller cannot bypass an unfinished legacy owner by generating a fresh UUID.
      expect(
        await electron.handlers.get("pragma-bundles:import")!(
          {},
          {
            requestId: randomUUID(),
            sourcePath: archive,
            rootRef: inspection.root.ref,
            expectedFingerprint: inspection.bundleFingerprint,
            expectedProjectFingerprint: inspection.projectFingerprint,
            expectedProjectRevision: inspection.projectRevision,
          },
        ),
      ).toMatchObject({ ok: false, error: { code: "installation_legacy_incomplete" } });
      const result = await electron.handlers.get("pragma-bundles:installation:recheck")!(
        {},
        { installationId: old!.id },
      );
      if (phase === "missing-journal") {
        expect(result).toMatchObject({
          ok: true,
          value: {
            id: old!.id,
            status: "failed",
            errorCode: "installation_legacy_recovery_unavailable",
            error: expect.stringContaining("known backup"),
          },
        });
        expect(await target.service.listInstallations()).toHaveLength(1);
        expect(await target.contextStores.list()).toHaveLength(1);
        expect((await target.project.get()).revision).toBe(0);
        return;
      }
      expect(result).toMatchObject({ ok: true, value: { id: old!.id, status: "ready" } });
      const [recovered] = await target.service.listInstallations();
      expect(await target.service.listInstallations()).toHaveLength(1);
      expect(await target.contextStores.list()).toHaveLength(1);
      const revision = (await target.project.get()).revision;
      expect(revision).toBe(1);
      expect(
        (await target.contextStores.getSnapshot(recovered!.createdContextStoreIds[0]!)).files,
      ).toContainEqual(
        expect.objectContaining({ id: "guide.md", content: "# Historical fixture\n" }),
      );
      expect(
        await electron.handlers.get("pragma-bundles:installation:recheck")!(
          {},
          { installationId: old!.id },
        ),
      ).toMatchObject({ ok: true, value: { status: "ready" } });
      expect((await target.project.get()).revision).toBe(revision);
    },
  );

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
