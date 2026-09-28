import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({ ipcRenderer: mocks }));
vi.mock("../invoke-mutation.ts", () => ({ invokeMutation: vi.fn() }));

import { assetGitApi } from "./asset-git.ts";

describe("assetGitApi", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.on.mockReset();
    mocks.removeListener.mockReset();
  });

  it("validates status events before forwarding them", () => {
    const listener = vi.fn();
    const unsubscribe = assetGitApi.subscribeAssetGitStatusUpdates(listener);
    const handler = mocks.on.mock.calls[0]?.[1] as
      ((event: unknown, value: unknown) => void) | undefined;
    expect(mocks.on).toHaveBeenCalledWith("asset-git:status:updated", expect.any(Function));

    handler?.(
      {},
      {
        target: { kind: "knowledge", id: "00000000-0000-4000-8000-000000000001" },
        status: "conflict",
        conflictPaths: ["guide.md"],
      },
    );
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "conflict" }));
    expect(() => handler?.({}, { status: "invalid" })).toThrow();

    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith("asset-git:status:updated", handler);
  });
});
