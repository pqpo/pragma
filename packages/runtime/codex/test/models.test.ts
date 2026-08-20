import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeCommandResult } from "@pragma/core/runtime/process-probe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRuntimeCommand: vi.fn(),
}));

vi.mock("@pragma/core/runtime/process-probe", () => ({
  runRuntimeCommand: mocks.runRuntimeCommand,
}));

import { createCodexModelDiscovery, parseCodexModels } from "../src/models.ts";

describe("Codex model discovery cache", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    mocks.runRuntimeCommand.mockReset();
    cacheRoot = await mkdtemp(join(tmpdir(), "pragma-codex-model-cache-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("shares a fresh catalog across adapter instances without probing the version", async () => {
    mocks.runRuntimeCommand.mockResolvedValue(commandResult(catalog("gpt-first")));
    const executablePath = `/codex/cache-${crypto.randomUUID()}`;

    const first = createCodexModelDiscovery(discoveryOptions(executablePath));
    const second = createCodexModelDiscovery(discoveryOptions(executablePath));

    await expect(first()).resolves.toMatchObject([
      { id: "gpt-first", inputModalities: ["text", "image"] },
    ]);
    await expect(second()).resolves.toMatchObject([{ id: "gpt-first" }]);
    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(1);
    expect(mocks.runRuntimeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["debug", "models", "--bundled"] }),
    );
  });

  it("preserves text-only model modality metadata for graceful image degradation", () => {
    expect(
      parseCodexModels(
        JSON.stringify({
          models: [
            {
              slug: "gpt-text",
              display_name: "GPT Text",
              input_modalities: ["text"],
              priority: 1,
              visibility: "list",
            },
          ],
        }),
      ),
    ).toMatchObject([{ id: "gpt-text", inputModalities: ["text"] }]);
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
    const first = createCodexModelDiscovery(discoveryOptions(executablePath))();
    const second = createCodexModelDiscovery(discoveryOptions(executablePath))();

    await flushPromises();
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
        modelCatalogCacheRoot: cacheRoot,
        onModelCatalogUpdated,
      });

      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(onModelCatalogUpdated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);

      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);

      finishRefresh?.(commandResult(catalog("gpt-refreshed")));
      await vi.waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1));
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
        .mockResolvedValueOnce(commandResult("", 1))
        .mockResolvedValueOnce(commandResult(catalog("gpt-recovered")));
      const onModelCatalogUpdated = vi.fn();
      const discovery = createCodexModelDiscovery({
        executablePath: `/codex/retry-${crypto.randomUUID()}`,
        modelCatalogCacheRoot: cacheRoot,
        onModelCatalogUpdated,
      });

      await discovery();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 1);
      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      await flushPromises();

      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(3);
      expect(onModelCatalogUpdated).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30 * 1_000 + 1);
      await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
      expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(4);
      await vi.waitFor(async () => {
        await expect(discovery()).resolves.toMatchObject([{ id: "gpt-recovered" }]);
      });
      await vi.waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });

  function discoveryOptions(executablePath: string) {
    return { executablePath, modelCatalogCacheRoot: cacheRoot };
  }
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
