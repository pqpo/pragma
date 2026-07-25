import type { RuntimeCommandResult } from "@pragma/core/runtime/process-probe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRuntimeCommand: vi.fn(),
}));

vi.mock("@pragma/core/runtime/process-probe", () => ({
  runRuntimeCommand: mocks.runRuntimeCommand,
}));

import { createCodexModelDiscovery } from "../src/models.ts";

describe("Codex model discovery cache", () => {
  beforeEach(() => {
    mocks.runRuntimeCommand.mockReset();
  });

  it("shares a fresh catalog across adapter instances without probing the version", async () => {
    mocks.runRuntimeCommand.mockResolvedValue(commandResult(catalog("gpt-first")));
    const executablePath = `/codex/cache-${crypto.randomUUID()}`;

    const first = createCodexModelDiscovery({ executablePath });
    const second = createCodexModelDiscovery({ executablePath });

    await expect(first()).resolves.toMatchObject([{ id: "gpt-first" }]);
    await expect(second()).resolves.toMatchObject([{ id: "gpt-first" }]);
    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runRuntimeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["debug", "models", "--bundled"] }),
    );
  });

  it("coalesces concurrent catalog loads", async () => {
    let finishDiscovery: ((result: RuntimeCommandResult) => void) | undefined;
    mocks.runRuntimeCommand.mockImplementationOnce(
      async () =>
        await new Promise<RuntimeCommandResult>((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const executablePath = `/codex/concurrent-${crypto.randomUUID()}`;
    const first = createCodexModelDiscovery({ executablePath })();
    const second = createCodexModelDiscovery({ executablePath })();

    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(1);
    finishDiscovery?.(commandResult(catalog("gpt-shared")));

    await expect(first).resolves.toMatchObject([{ id: "gpt-shared" }]);
    await expect(second).resolves.toMatchObject([{ id: "gpt-shared" }]);
  });

  it("returns stale models immediately and refreshes them in the background", async () => {
    vi.useFakeTimers();
    try {
      let finishRefresh: ((result: RuntimeCommandResult) => void) | undefined;
      mocks.runRuntimeCommand
        .mockResolvedValueOnce(commandResult(catalog("gpt-cached")))
        .mockImplementationOnce(
          async () =>
            await new Promise<RuntimeCommandResult>((resolve) => {
              finishRefresh = resolve;
            }),
        );
      const onModelCatalogUpdated = vi.fn();
      const discovery = createCodexModelDiscovery({
        executablePath: `/codex/stale-${crypto.randomUUID()}`,
        onModelCatalogUpdated,
      });

      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(onModelCatalogUpdated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);

      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);

      finishRefresh?.(commandResult(catalog("gpt-refreshed")));
      await flushPromises();
      expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1);
      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-refreshed" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off after a stale catalog refresh fails", async () => {
    vi.useFakeTimers();
    try {
      mocks.runRuntimeCommand
        .mockResolvedValueOnce(commandResult(catalog("gpt-cached")))
        .mockResolvedValueOnce(commandResult("", 1))
        .mockResolvedValueOnce(commandResult(catalog("gpt-recovered")));
      const discovery = createCodexModelDiscovery({
        executablePath: `/codex/retry-${crypto.randomUUID()}`,
      });

      await discovery();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);
      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      await flushPromises();

      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30 * 1_000 + 1);
      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(3);
      await flushPromises();
      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-recovered" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function catalog(modelId: string): string {
  return JSON.stringify({
    models: [
      {
        slug: modelId,
        display_name: modelId,
        priority: 1,
        visibility: "list",
      },
    ],
  });
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function commandResult(stdout: string, exitCode = 0): RuntimeCommandResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: "",
  };
}
