import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineRuntimeDriver } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { getRuntimeAvailability } from "./runtime-availability.ts";
import { createRuntimeEnvironmentService } from "./runtime-environment-service.ts";
import { createRuntimeEnvironmentStore } from "./runtime-environment-store.ts";

describe("getRuntimeAvailability", () => {
  it("isolates adapter health and reports model catalogs", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-runtime-availability-"));
    const definitions = [definition("healthy", "Healthy"), definition("broken", "Broken")];
    const store = createRuntimeEnvironmentStore({
      pragmaHome,
      builtIns: definitions,
      defaultRuntimeId: "healthy",
    });
    const runtimes = createRuntimeEnvironmentService({
      store,
      factories: [
        {
          id: "test.runtime",
          version: "v1",
          create: (environment) =>
            defineRuntimeDriver({
              descriptor: {
                id: environment.id,
                kind: "test",
                displayName: environment.displayName,
              },
              canUse: () =>
                environment.id === "healthy"
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
        id: "healthy",
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
