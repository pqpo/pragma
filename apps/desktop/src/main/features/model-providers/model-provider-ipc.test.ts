import { beforeEach, describe, expect, it, vi } from "vitest";

import { installModelProviderHandlers } from "./model-provider-ipc.ts";
import { ModelProviderStoreError, type ModelProviderStore } from "./model-provider-store.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electron.handlers.set(channel, handler);
  }),
}));

vi.mock("electron", () => ({ ipcMain: { handle: electron.handle } }));

describe("model provider IPC", () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.handle.mockClear();
  });

  it("returns an actionable discovery result when the edited provider was removed", async () => {
    const resolveDiscoveryApiKey = vi
      .fn()
      .mockRejectedValue(
        new ModelProviderStoreError("provider_not_found", "The provider no longer exists."),
      );
    installModelProviderHandlers({ resolveDiscoveryApiKey } as unknown as ModelProviderStore);

    const discover = electron.handlers.get("model-providers:discover");
    expect(discover).toBeDefined();

    await expect(
      discover?.(
        {},
        {
          presetId: "openai",
          protocol: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          providerId: "00000000-0000-4000-8000-000000000001",
        },
      ),
    ).resolves.toEqual({
      ok: false,
      models: [],
      message:
        "This provider was removed while it was being configured. Return to the provider list and add or select it again.",
      source: "manual",
    });
  });
});
