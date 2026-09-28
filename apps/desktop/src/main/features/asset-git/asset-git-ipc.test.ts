import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: (name: string, handler: (event: unknown, value: unknown) => unknown) =>
        handlers.set(name, handler),
    },
    ipcRenderer: {
      invoke: async (name: string, value: unknown) => await handlers.get(name)?.({}, value),
    },
  };
});
vi.mock("electron", () => bridge);

import { installAssetGitHandlers } from "./asset-git-ipc.ts";
import type { AssetGitService } from "./asset-git-service.ts";
import { assetGitApi } from "../../../preload/api/asset-git.ts";

const target = { kind: "knowledge" as const, id: "00000000-0000-4000-8000-000000000001" };
const source = { remote: "https://example.test/asset.git" };

describe("asset Git IPC and preload boundary", () => {
  beforeEach(() => bridge.handlers.clear());
  it("unwraps successful mutations rather than treating returned status objects as validation errors", async () => {
    const status = { target, source, status: "synced" as const };
    const service = {
      status: async () => status,
      bind: async () => status,
      sync: async () => status,
      unbind: async () => {},
      import: async () => target,
      conflicts: async () => ({ target, snapshot: "a".repeat(64), files: [] }),
      resolve: async () => status,
    } as unknown as AssetGitService;
    installAssetGitHandlers(service);
    await expect(assetGitApi.bindAssetGit({ target, source })).resolves.toEqual(status);
    await expect(assetGitApi.syncAssetGit(target)).resolves.toEqual(status);
    await expect(assetGitApi.importAssetGit({ kind: "knowledge", source })).resolves.toEqual(
      target,
    );
    await expect(assetGitApi.unbindAssetGit(target)).resolves.toBeUndefined();
    await expect(assetGitApi.getAssetGitConflicts(target)).resolves.toMatchObject({ files: [] });
    await expect(
      assetGitApi.resolveAssetGitConflicts({
        target,
        snapshot: "a".repeat(64),
        resolutions: [{ path: "guide.md", choice: "local" }],
      }),
    ).resolves.toEqual(status);
  });
  it("returns structured failures and rejects unsafe resolution paths before execution", async () => {
    const resolve = vi.fn();
    installAssetGitHandlers({
      sync: async () => {
        throw new Error("Network offline");
      },
      resolve,
    } as unknown as AssetGitService);
    await expect(assetGitApi.syncAssetGit(target)).rejects.toMatchObject({
      message: "Network offline",
    });
    const response = await bridge.ipcRenderer.invoke("asset-git:resolve", {
      target,
      snapshot: "a".repeat(64),
      resolutions: [{ path: "../secret", choice: "local" }],
    });
    expect(response).toMatchObject({ ok: false });
    expect(resolve).not.toHaveBeenCalled();
  });
});
