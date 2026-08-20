import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@qoder-ai/qoder-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@qoder-ai/qoder-agent-sdk")>()),
  query: sdk.query,
}));

import {
  createQoderCliModelDiscovery,
  mapQoderModel,
  resolveQoderContextWindow,
} from "../src/models.ts";

describe("Qoder model mapping", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    sdk.query.mockReset();
    cacheRoot = await mkdtemp(join(tmpdir(), "pragma-qoder-model-cache-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("maps model defaults, thinking efforts, and provider identity", () => {
    expect(
      mapQoderModel({
        value: "performance",
        displayName: "Performance",
        description: "Fast",
        isDefault: true,
        supportsDisabled: true,
        efforts: ["low", "high"],
        defaultEffort: "high",
      }),
    ).toMatchObject({
      id: "performance",
      default: true,
      inputModalities: ["text"],
      provider: { id: "qoder", kind: "runtime-managed" },
      thinking: {
        defaultLevel: "high",
        supportedLevels: [{ value: "none" }, { value: "low" }, { value: "high" }],
      },
    });
  });

  it("uses the model default context window and allows an explicit override", () => {
    const model = {
      value: "performance",
      displayName: "Performance",
      description: "Fast",
      availableContextWindows: [100_000, 200_000],
      defaultContextWindow: 200_000,
    };
    expect(resolveQoderContextWindow(model, undefined)).toBe(200_000);
    expect(resolveQoderContextWindow(model, 300_000)).toBe(300_000);
  });

  it("fails closed when no context denominator is available", () => {
    expect(() =>
      resolveQoderContextWindow(
        { value: "unknown", displayName: "Unknown", description: "" },
        undefined,
      ),
    ).toThrow("does not report a context window");
  });

  it("coalesces live discovery across adapters with the same executable, auth, and env", async () => {
    const getAvailableModels = vi.fn().mockResolvedValue([
      {
        value: "performance",
        displayName: "Performance",
        description: "Fast",
        isEnabled: true,
      },
    ]);
    const close = vi.fn().mockResolvedValue(undefined);
    sdk.query.mockImplementation(() => ({ getAvailableModels, close }));
    const options = {
      executablePath: `/opt/qodercli-${randomUUID()}`,
      auth: { type: "qodercli" as const },
      env: { QODER_TEST_CATALOG: "same" },
      modelCatalogCacheRoot: cacheRoot,
    };
    const first = createQoderCliModelDiscovery(options);
    const second = createQoderCliModelDiscovery(options);

    const [firstModels, secondModels] = await Promise.all([first(), second()]);

    expect(firstModels).toEqual(secondModels);
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(getAvailableModels).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses a different catalog cache when executable configuration changes", async () => {
    const getAvailableModels = vi.fn().mockResolvedValue([
      {
        value: "performance",
        displayName: "Performance",
        description: "Fast",
        isEnabled: true,
      },
    ]);
    sdk.query.mockImplementation(() => ({
      getAvailableModels,
      close: vi.fn().mockResolvedValue(undefined),
    }));
    const executable = `/opt/qodercli-${randomUUID()}`;

    await createQoderCliModelDiscovery({
      executablePath: executable,
      env: { QODER_TEST_CATALOG: "first" },
      modelCatalogCacheRoot: cacheRoot,
    })();
    await createQoderCliModelDiscovery({
      executablePath: executable,
      env: { QODER_TEST_CATALOG: "second" },
      modelCatalogCacheRoot: cacheRoot,
    })();

    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(getAvailableModels).toHaveBeenCalledTimes(2);
  });
});
