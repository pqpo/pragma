import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRuntimeModelCatalogModels,
  readRuntimeModelCatalogCache,
  writeRuntimeModelCatalogCache,
} from "@pragma/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  connectOpenCode: vi.fn(),
  listModels: vi.fn(),
  probeOpenCode: vi.fn(),
  startOpenCodeProcess: vi.fn(),
}));

vi.mock("../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client.ts")>()),
  connectOpenCode: mocks.connectOpenCode,
}));

vi.mock("../src/process.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/process.ts")>()),
  probeOpenCode: mocks.probeOpenCode,
  startOpenCodeProcess: mocks.startOpenCodeProcess,
}));

import { createOpenCodeModelDiscovery, mapOpenCodeModel } from "../src/models.ts";

describe("OpenCode model mapping", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    cacheRoot = await mkdtemp(join(tmpdir(), "pragma-opencode-model-cache-"));
    mocks.probeOpenCode.mockResolvedValue({ major: 1, version: "1.18.32" });
    mocks.startOpenCodeProcess.mockResolvedValue({});
    mocks.close.mockResolvedValue(undefined);
    mocks.connectOpenCode.mockImplementation(() => ({
      listModels: mocks.listModels,
      close: mocks.close,
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("preserves native variants as thinking levels", () => {
    expect(
      mapOpenCodeModel({
        providerId: "openai",
        providerName: "OpenAI",
        modelId: "gpt-test",
        displayName: "GPT Test",
        variants: ["low", "high"],
        isDefault: true,
      }),
    ).toMatchObject({
      id: "gpt-test",
      default: true,
      thinking: {
        supportedLevels: [
          { value: "low", label: "low" },
          { value: "high", label: "high" },
        ],
      },
    });
  });

  it("does not invent thinking levels when the native catalog has none", () => {
    expect(
      mapOpenCodeModel({
        providerId: "openai",
        providerName: "OpenAI",
        modelId: "gpt-test",
        displayName: "GPT Test",
        variants: [],
      }),
    ).not.toHaveProperty("thinking");
  });

  it("preserves variants through the shared persistent catalog", async () => {
    const options = { runtimeId: "opencode", cacheKey: "variants", cacheRoot };
    const model = mapOpenCodeModel(nativeModel("gpt-test", ["low", "high"]));
    await writeRuntimeModelCatalogCache(options, [model]);
    await expect(
      readRuntimeModelCatalogCache(options, parseRuntimeModelCatalogModels),
    ).resolves.toMatchObject([
      {
        thinking: {
          supportedLevels: [
            { value: "low", label: "low" },
            { value: "high", label: "high" },
          ],
        },
      },
    ]);
  });

  it("coalesces concurrent live discovery across adapter instances", async () => {
    let finishDiscovery: ((models: ReturnType<typeof nativeModel>[]) => void) | undefined;
    mocks.listModels.mockImplementationOnce(
      async () =>
        await new Promise<ReturnType<typeof nativeModel>[]>((resolve) => {
          finishDiscovery = resolve;
        }),
    );
    const options = discoveryOptions();
    const first = createOpenCodeModelDiscovery(options)();
    const second = createOpenCodeModelDiscovery(options)();

    await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(1));
    finishDiscovery?.([nativeModel("gpt-shared")]);

    await expect(first).resolves.toMatchObject([{ id: "gpt-shared" }]);
    await expect(second).resolves.toMatchObject([{ id: "gpt-shared" }]);
    expect(mocks.probeOpenCode).toHaveBeenCalledTimes(1);
    expect(mocks.startOpenCodeProcess).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns a persisted catalog without waiting for its background refresh", async () => {
    let finishRefresh: ((models: ReturnType<typeof nativeModel>[]) => void) | undefined;
    mocks.listModels.mockImplementationOnce(
      async () =>
        await new Promise<ReturnType<typeof nativeModel>[]>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const options = discoveryOptions();
    await writeRuntimeModelCatalogCache(
      {
        runtimeId: "opencode",
        cacheKey: discoveryCacheKey(options),
        cacheRoot,
      },
      [mapOpenCodeModel(nativeModel("gpt-persisted"))],
    );
    const onModelCatalogUpdated = vi.fn();
    const discovery = createOpenCodeModelDiscovery({ ...options, onModelCatalogUpdated });

    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-persisted" }]);
    await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(1));
    expect(onModelCatalogUpdated).not.toHaveBeenCalled();

    finishRefresh?.([nativeModel("gpt-refreshed")]);
    await vi.waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1));
    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-refreshed" }]);
  });

  it("waits for an explicit forced refresh", async () => {
    mocks.listModels
      .mockResolvedValueOnce([nativeModel("gpt-cached")])
      .mockResolvedValueOnce([nativeModel("gpt-forced")]);
    const onModelCatalogUpdated = vi.fn();
    const discovery = createOpenCodeModelDiscovery({
      ...discoveryOptions(),
      onModelCatalogUpdated,
    });

    await discovery();
    await expect(discovery({ forceRefresh: true })).resolves.toMatchObject([{ id: "gpt-forced" }]);
    expect(mocks.listModels).toHaveBeenCalledTimes(2);
    expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("returns stale models immediately and refreshes them in the background", async () => {
    vi.useFakeTimers();
    mocks.listModels
      .mockResolvedValueOnce([nativeModel("gpt-cached")])
      .mockResolvedValueOnce([nativeModel("gpt-refreshed")]);
    const onModelCatalogUpdated = vi.fn();
    const discovery = createOpenCodeModelDiscovery({
      ...discoveryOptions(),
      onModelCatalogUpdated,
    });

    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);

    await vi.waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1));
    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-refreshed" }]);
    expect(mocks.listModels).toHaveBeenCalledTimes(2);
  });

  it("backs off after a stale catalog refresh fails", async () => {
    vi.useFakeTimers();
    mocks.listModels
      .mockResolvedValueOnce([nativeModel("gpt-cached")])
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce([nativeModel("gpt-recovered")]);
    const onModelCatalogUpdated = vi.fn();
    const discovery = createOpenCodeModelDiscovery({
      ...discoveryOptions(),
      onModelCatalogUpdated,
    });

    await discovery();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
    await vi.waitFor(() => expect(mocks.listModels).toHaveBeenCalledTimes(3));

    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
    expect(mocks.listModels).toHaveBeenCalledTimes(3);
    expect(onModelCatalogUpdated).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000 + 1);
    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-cached" }]);
    await vi.waitFor(() => expect(onModelCatalogUpdated).toHaveBeenCalledTimes(1));
    await expect(discovery()).resolves.toMatchObject([{ id: "gpt-recovered" }]);
    expect(mocks.listModels).toHaveBeenCalledTimes(4);
  });

  function discoveryOptions() {
    return {
      executablePath: `/opencode/${randomUUID()}`,
      env: { HOME: cacheRoot },
      modelCatalogCacheRoot: cacheRoot,
    };
  }
});

function nativeModel(modelId: string, variants: string[] = []) {
  return {
    providerId: "openai",
    providerName: "OpenAI",
    modelId,
    displayName: modelId,
    variants,
  };
}

function discoveryCacheKey(options: {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  modelCatalogCacheRoot: string;
}): string {
  return createHash("sha256")
    .update("pragma.opencode-model-catalog/v1\0")
    .update(options.executablePath)
    .update("\0")
    .update(options.modelCatalogCacheRoot)
    .update("\0")
    .update(
      JSON.stringify(
        Object.entries(options.env).toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}
