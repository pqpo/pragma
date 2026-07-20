import type { RuntimeModel, RuntimeResolver } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { createMissionExecutorCatalog } from "./mission-executor-catalog.ts";
import { ModelProviderStoreError } from "./model-provider-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "./system-expert-registry.ts";

describe("Mission executor model options", () => {
  it("returns a reset-required state for an unsupported provider config", async () => {
    const catalog = createCatalog(async () => {
      throw new ModelProviderStoreError(
        "config_invalid",
        "This model provider configuration uses an older format.",
      );
    });

    await expect(catalog.getModelOptions("expert:steward@1.0.0")).resolves.toEqual({
      status: "reset_required",
      models: [],
    });
  });

  it("keeps normal runtime model catalogs ready", async () => {
    const catalog = createCatalog(async () => [
      {
        id: "model",
        displayName: "Model",
        provider: {
          kind: "runtime-managed" as const,
          id: "provider",
          displayName: "Provider",
        },
      },
    ]);

    await expect(catalog.getModelOptions("expert:steward@1.0.0")).resolves.toMatchObject({
      status: "ready",
      models: [{ id: "model" }],
    });
  });
});

function createCatalog(listModels: () => Promise<readonly RuntimeModel[]>) {
  const runtimes: RuntimeResolver = {
    getDefaultRuntimeId: async () => "pi",
    bind: async () => ({
      binding: { runtimeId: "pi", revision: 1, fingerprint: "a".repeat(64) },
      adapter: {
        descriptor: { id: "pi", kind: "cloud-pi-agent", displayName: "PI" },
        canUse: async () => ({ usable: true }),
        listModels,
        createSession: async () => {
          throw new Error("unused");
        },
      },
    }),
    resolve: async () => {
      throw new Error("unused");
    },
  };
  const systemExperts = {
    get: () => ({ executionProfile: { mode: "system-default" } }),
    getExecutor: () => undefined,
    listExecutors: () => [],
  } as unknown as DesktopSystemExpertRegistry;
  const project = {
    get: async () => {
      throw new Error("unused");
    },
  } as unknown as PragmaProjectStore;
  return createMissionExecutorCatalog({ project, systemExperts, runtimes });
}
