import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { describe, expect, it } from "vitest";

import { getRuntimeAvailability } from "./runtime-availability.ts";
import { createRuntimeEnvironmentService } from "./runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";

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
