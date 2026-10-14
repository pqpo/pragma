import { beforeEach, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: ipc }));
import { coreAssetSyncApi } from "./core-asset-sync.ts";
const overview = {
  schemaVersion: "pragma.asset-sync-overview/v2",
  status: "ready",
  items: [
    {
      key: "expert:expert:0123456789abcdef",
      kind: "expert",
      name: "Writer",
      assetKey: "expert:0123456789abcdef",
      assetKind: "expert",
      assetName: "Writer",
      status: "synced",
      readiness: { status: "needs_attention", message: "Choose a model" },
    },
  ],
};
beforeEach(() => ipc.invoke.mockReset());
it("validates the v2 main-to-preload overview while retaining independent readiness", async () => {
  ipc.invoke.mockResolvedValue(overview);
  expect(await coreAssetSyncApi.getCoreAssetSyncOverview()).toEqual(overview);
  ipc.invoke.mockResolvedValue({ ok: true, value: overview });
  expect(await coreAssetSyncApi.syncCoreAssets()).toEqual(overview);
});
it.each(["pragma.asset-sync-overview/v1", "pragma.asset-sync-overview/v3"])(
  "rejects %s responses",
  async (schemaVersion) => {
    ipc.invoke.mockResolvedValue({ ...overview, schemaVersion });
    await expect(coreAssetSyncApi.getCoreAssetSyncOverview()).rejects.toThrow();
  },
);
it("rejects obsolete deletion options at the mutation boundary", async () => {
  await expect(
    coreAssetSyncApi.updateCoreAssetSyncConfiguration({
      remote: "ssh://git@pragma.test/assets.git",
      autoPush: true,
      pushDeletions: false,
    } as never),
  ).rejects.toThrow();
  expect(ipc.invoke).not.toHaveBeenCalled();
});
