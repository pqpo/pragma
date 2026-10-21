import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { describe, expect, it, vi } from "vitest";

import {
  getRuntimeAvailability,
  getTargetRuntimeAvailability,
  invalidateTargetRuntimeAvailability,
} from "./runtime-availability.ts";
import { createRuntimeEnvironmentService } from "./runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "@pragma/local-host/deployment";

describe("getRuntimeAvailability", () => {
  it("isolates adapter health and reports model catalogs", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-availability-"));
    const definitions = [definition("pi", "Healthy"), definition("broken", "Broken")];
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: definitions,
    });
    const runtimes = createRuntimeEnvironmentService({
      store,
      factories: [
        {
          id: "test.runtime",
          version: "v1",
          create: (environment) =>
            defineRuntimeTestDriver({
              descriptor: {
                id: environment.id,
                kind: "test",
                displayName: environment.displayName,
              },
              canUse: () =>
                environment.id === "pi"
                  ? { usable: true, details: { version: "1.2.3" } }
                  : { usable: false, reason: "not configured" },
              listModels: async () => [
                {
                  id: "model",
                  displayName: "Model",
                  provider: { kind: "runtime-managed", id: "test", displayName: "Test" },
                },
              ],
              createSession: () => ({}),
              startTurn: () => ({ outputText: "" }),
              mapEvent: () => ({ events: [] }),
            }),
        },
      ],
    });

    const availability = await getRuntimeAvailability(runtimes);
    expect(availability).toEqual([
      expect.objectContaining({
        id: "pi",
        revision: 1,
        isDefault: true,
        status: "available",
        version: "1.2.3",
        models: [expect.objectContaining({ id: "model" })],
      }),
      expect.objectContaining({
        id: "broken",
        isDefault: false,
        status: "unavailable",
        reason: "not configured",
      }),
    ]);
  });

  it("projects the built-in Runtime identity without rewriting diagnostics", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-availability-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("pi", "PI Runtime")],
    });
    const runtimes = createRuntimeEnvironmentService({
      store,
      factories: [
        {
          id: "test.runtime",
          version: "v1",
          create: (environment) =>
            defineRuntimeTestDriver({
              descriptor: {
                id: environment.id,
                kind: "cloud-pi-agent",
                displayName: environment.displayName,
              },
              canUse: () => ({
                usable: false,
                reason: "The built-in runtime is not configured.",
              }),
              createSession: () => ({}),
              startTurn: () => ({ outputText: "" }),
              mapEvent: () => ({ events: [] }),
            }),
        },
      ],
    });

    await expect(getRuntimeAvailability(runtimes, { forceRefresh: true })).resolves.toEqual([
      expect.objectContaining({
        id: "pi",
        displayName: "Built-in Runtime",
        reason: "The built-in runtime is not configured.",
      }),
    ]);
  });

  it("forwards forceRefresh to Runtime model discovery", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-availability-refresh-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("pi", "Pi"), definition("codex", "Codex")],
    });
    const receivedOptions: unknown[] = [];
    const runtimes = createRuntimeEnvironmentService({
      store,
      factories: [
        {
          id: "test.runtime",
          version: "v1",
          create: (environment) =>
            defineRuntimeTestDriver({
              descriptor: {
                id: environment.id,
                kind: "test",
                displayName: environment.displayName,
              },
              canUse: () => ({ usable: true }),
              listModels: async (options) => {
                receivedOptions.push(options);
                return [];
              },
              createSession: () => ({}),
              startTurn: () => ({ outputText: "" }),
              mapEvent: () => ({ events: [] }),
            }),
        },
      ],
    });

    await getRuntimeAvailability(runtimes, { forceRefresh: true });

    expect(receivedOptions).toEqual([{ forceRefresh: true }, { forceRefresh: true }]);
  });

  it("reprobes cached availability after the process environment generation changes", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-availability-generation-"));
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("pi", "Pi")],
    });
    let environmentGeneration = 1;
    const runtimes = createRuntimeEnvironmentService({
      store,
      getMaterializationCacheKey: () => `environment:${environmentGeneration}`,
      factories: [
        {
          id: "test.runtime",
          version: "v1",
          create: (environment) => {
            const version = String(environmentGeneration);
            return defineRuntimeTestDriver({
              descriptor: {
                id: environment.id,
                kind: "test",
                displayName: environment.displayName,
              },
              canUse: () => ({ usable: true, details: { version } }),
              createSession: () => ({}),
              startTurn: () => ({ outputText: "" }),
              mapEvent: () => ({ events: [] }),
            });
          },
        },
      ],
    });

    await expect(getRuntimeAvailability(runtimes)).resolves.toEqual([
      expect.objectContaining({ version: "1" }),
    ]);
    environmentGeneration += 1;
    await expect(getRuntimeAvailability(runtimes)).resolves.toEqual([
      expect.objectContaining({ version: "2" }),
    ]);
  });

  it("limits probe concurrency and respects forceRefresh options", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-availability-concurrency-"));
    const definitions = [
      definition("pi", "Pi"),
      definition("r2", "R2"),
      definition("r3", "R3"),
      definition("r4", "R4"),
    ];
    const store = createRuntimeEnvironmentStore({ pragmaHome, builtIns: definitions });

    let activeProbes = 0;
    let maxObservedConcurrency = 0;
    const receivedOptions: Record<string, unknown>[] = [];

    const runtimes = createRuntimeEnvironmentService({
      store,
      factories: [
        {
          id: "test.runtime",
          version: "v1",
          create: (env) =>
            defineRuntimeTestDriver({
              descriptor: { id: env.id, kind: "test", displayName: env.displayName },
              canUse: async (opts?: Record<string, unknown>) => {
                if (opts) receivedOptions.push(opts);
                activeProbes++;
                maxObservedConcurrency = Math.max(maxObservedConcurrency, activeProbes);
                await new Promise((resolve) => setTimeout(resolve, 20));
                activeProbes--;
                return { usable: true, details: { version: "1.0.0" } };
              },
              createSession: () => ({}),
              startTurn: () => ({ outputText: "" }),
              mapEvent: () => ({ events: [] }),
            }),
        },
      ],
    });

    const availability = await getRuntimeAvailability(runtimes, { forceRefresh: true });
    expect(availability).toHaveLength(4);
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
    expect(receivedOptions).toContainEqual({ forceRefresh: true });
  });
});

it("maps Local Host target readiness into the Desktop availability DTO", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-target-mapping-"));
  const runtimes = createRuntimeEnvironmentService({
    store: createRuntimeEnvironmentStore({ pragmaHome, builtIns: [definition("pi", "Pi")] }),
    factories: [
      {
        id: "test.runtime",
        version: "v1",
        create: (environment) =>
          defineRuntimeTestDriver({
            descriptor: { id: environment.id, kind: "test", displayName: environment.displayName },
            canUse: () => ({ usable: false, reason: "not configured" }),
            createSession: () => ({}),
            startTurn: () => ({ outputText: "" }),
            mapEvent: () => ({ events: [] }),
          }),
      },
    ],
  });
  await expect(getTargetRuntimeAvailability(runtimes, ["pi"])).resolves.toEqual([
    expect.objectContaining({
      id: "pi",
      revision: 1,
      status: "unavailable",
      reason: "not configured",
    }),
  ]);
});

it("discovers only target models, coalesces concurrent reads and refreshes after expiry or invalidation", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-target-models-"));
  const listModels = vi.fn(async () => [
    {
      id: "model",
      displayName: "Model",
      provider: { kind: "runtime-managed" as const, id: "test", displayName: "Test" },
    },
  ]);
  const unrelatedModels = vi.fn(async () => []);
  const runtimes = createRuntimeEnvironmentService({
    store: createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: [definition("pi", "Pi"), definition("other", "Other")],
    }),
    factories: [
      {
        id: "test.runtime",
        version: "v1",
        create: (environment) =>
          defineRuntimeTestDriver({
            descriptor: { id: environment.id, kind: "test", displayName: environment.displayName },
            canUse: () => ({ usable: true }),
            listModels: environment.id === "pi" ? listModels : unrelatedModels,
            createSession: () => ({}),
            startTurn: () => ({ outputText: "" }),
            mapEvent: () => ({ events: [] }),
          }),
      },
    ],
  });
  const read = () => getTargetRuntimeAvailability(runtimes, ["pi", "pi"], { includeModels: true });
  expect((await getTargetRuntimeAvailability(runtimes, ["pi"]))[0]?.models).toBeUndefined();
  expect(listModels).not.toHaveBeenCalled();
  const [first, second] = await Promise.all([read(), read()]);
  expect(first).toEqual(second);
  expect(first).toHaveLength(1);
  expect(first[0]?.models).toEqual(await listModels.mock.results[0]!.value);
  expect(listModels).toHaveBeenCalledTimes(1);
  expect(unrelatedModels).not.toHaveBeenCalled();
  const realDateNow = Date.now.bind(Date);
  const dateNow = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + 31_000);
  try {
    await read();
    expect(listModels).toHaveBeenCalledTimes(2);
  } finally {
    dateNow.mockRestore();
  }
  invalidateTargetRuntimeAvailability(runtimes);
  await read();
  expect(listModels).toHaveBeenCalledTimes(3);
  expect(unrelatedModels).not.toHaveBeenCalled();
});

it("preserves model discovery failures and retries them without reimporting", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-target-discovery-failure-"));
  let failed = true;
  const listModels = vi.fn(async () => {
    if (failed) throw new Error("Authentication expired");
    return [];
  });
  const runtimes = createRuntimeEnvironmentService({
    store: createRuntimeEnvironmentStore({ pragmaHome, builtIns: [definition("pi", "Pi")] }),
    factories: [
      {
        id: "test.runtime",
        version: "v1",
        create: (environment) =>
          defineRuntimeTestDriver({
            descriptor: { id: environment.id, kind: "test", displayName: environment.displayName },
            canUse: () => ({ usable: true }),
            listModels,
            createSession: () => ({}),
            startTurn: () => ({ outputText: "" }),
            mapEvent: () => ({ events: [] }),
          }),
      },
    ],
  });
  await expect(
    getTargetRuntimeAvailability(runtimes, ["pi"], { includeModels: true }),
  ).resolves.toEqual([
    expect.objectContaining({ status: "available", modelDiscoveryError: "Authentication expired" }),
  ]);
  failed = false;
  const recovered = await getTargetRuntimeAvailability(runtimes, ["pi"], { includeModels: true });
  expect(recovered[0]?.models).toEqual([]);
  expect(recovered[0]?.modelDiscoveryError).toBeUndefined();
  expect(listModels).toHaveBeenCalledTimes(2);
});

it("does not reuse an old adapter catalog when invalidation races with a target read", async () => {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-target-catalog-race-"));
  let selectedModel = "old";
  let adapterCreated = false;
  const runtimes = createRuntimeEnvironmentService({
    store: createRuntimeEnvironmentStore({ pragmaHome, builtIns: [definition("pi", "Pi")] }),
    factories: [
      {
        id: "test.runtime",
        version: "v1",
        create: (environment) => {
          const model = selectedModel;
          adapterCreated = true;
          return defineRuntimeTestDriver({
            descriptor: { id: environment.id, kind: "test", displayName: environment.displayName },
            canUse: () => ({ usable: true }),
            listModels: async () => [
              {
                id: model,
                displayName: model,
                provider: { kind: "runtime-managed", id: "test", displayName: "Test" },
              },
            ],
            createSession: () => ({}),
            startTurn: () => ({ outputText: "" }),
            mapEvent: () => ({ events: [] }),
          });
        },
      },
    ],
  });
  const getKey = runtimes.getMaterializationCacheKey.bind(runtimes);
  let intercepted = false;
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const keySpy = vi.spyOn(runtimes, "getMaterializationCacheKey").mockImplementation(async () => {
    // Readiness first captures the adapter, then the model cache reads its environment key.
    if (adapterCreated && !intercepted) {
      intercepted = true;
      reached();
      await released;
    }
    return await getKey();
  });
  const oldRead = getTargetRuntimeAvailability(runtimes, ["pi"], { includeModels: true });
  try {
    await paused;
    selectedModel = "new";
    invalidateTargetRuntimeAvailability(runtimes);
    resume();
    expect((await oldRead)[0]?.models?.[0]?.id).toBe("old");
    const current = await getTargetRuntimeAvailability(runtimes, ["pi"], { includeModels: true });
    expect(current[0]?.models?.[0]?.id).toBe("new");
  } finally {
    resume();
    await oldRead;
    keySpy.mockRestore();
  }
});

function definition(id: string, displayName: string) {
  return {
    schemaVersion: "pragma.runtime-environment/v1" as const,
    id,
    adapter: { id: "test.runtime", version: "v1" },
    displayName,
    origin: "built-in" as const,
    config: {},
  };
}
